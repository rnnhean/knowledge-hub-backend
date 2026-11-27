"""本地 mem0 服务（自托管）。

**为什么需要这个服务**：
knowledge-hub 原来用的是 mem0 **云服务**（api.mem0.ai），免费额度 30 天后
写入被锁（需要绑自己的 LLM key），而官方 Docker 镜像只有 arm64，
本机 amd64 跑不了。所以改成自托管：用 mem0 的 OSS 版（Python 包），
本地起一个兼容 mem0 平台 API 的 HTTP 服务，后端只改一个 baseURL。

**复用什么**：
- LLM：现有的 dashscope `qwen-plus`（做事实抽取）
- Embedding：现有的 `text-embedding-v3`（1024 维）
- 向量库：Qdrant 本地嵌入式（不需要额外容器，数据落磁盘）

**为什么不用 knowledge-hub 已有的 ES**：mem0 的 ES 适配器要求自己管理索引结构，
和 knowledge-hub 现有的 `kh_chunk` 并存会互相干扰（同集群不同索引虽可行，
但 mem0 的索引名不可配置，冲突风险大于收益）。本地 Qdrant 文件模式最省事。

**接口兼容性**：只实现 knowledge-hub 实际用到的方法：
`add` / `search` / `get_all` / `delete_all`。
路径与 mem0 平台一致（`/v1/memories/`），这样后端代码不用改逻辑。
"""

from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# 加载同目录 .env。放在 import 之后、app 之前：
# 配置必须在 get_memory() 被首次调用前就位，而 init 是懒的，
# 所以在这个位置加载足够早，也不会因为缺文件让模块导入失败。
try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover - 生产环境用真实环境变量
    pass

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("mem0-local")

app = FastAPI(title="mem0 local", version="1.0.0")

_memory = None


def get_memory():
    """懒加载 mem0 实例。

    首次调用时才初始化，因为要读环境变量并连 embedding 服务——
    启动时就初始化会让服务在缺配置时起不来，健康检查也就没法用。
    """
    global _memory
    if _memory is not None:
        return _memory

    from mem0 import Memory

    base_url = os.environ["LLM_BASE_URL"]
    api_key = os.environ["LLM_API_KEY"]
    llm_model = os.environ.get("LLM_MODEL", "qwen-plus")
    embed_model = os.environ.get("EMBEDDING_MODEL", "text-embedding-v3")

    config = {
        "llm": {
            "provider": "openai",
            "config": {
                "model": llm_model,
                "openai_base_url": base_url,
                "api_key": api_key,
                "temperature": 0.1,
            },
        },
        "embedder": {
            "provider": "openai",
            "config": {
                "model": embed_model,
                "openai_base_url": base_url,
                "api_key": api_key,
                "embedding_dims": 1024,
            },
        },
        "vector_store": {
            "provider": "qdrant",
            "config": {
                # 本地文件模式：数据落在 data/ 目录，重启不丢，不需要额外容器
                "path": os.environ.get("MEM0_QDRANT_PATH", "./data/qdrant"),
                "collection_name": "kh_memory",
                "embedding_model_dims": 1024,
            },
        },
    }
    log.info("初始化 mem0：llm=%s embed=%s", llm_model, embed_model)
    _memory = Memory.from_config(config)
    return _memory


# 平台 API 的请求体形状


class Message(BaseModel):
    role: str
    content: str


class AddRequest(BaseModel):
    messages: list[Message]
    user_id: str | None = None
    run_id: str | None = None
    metadata: dict[str, Any] | None = None


class SearchRequest(BaseModel):
    query: str
    # **平台 SDK（mem0ai 3.x）传的是 filters，不是顶层 user_id**。
    # 它支持嵌套：{"user_id": "u1"} 或 {"AND": [{"user_id": "u1"}, {"run_id": "r1"}]}。
    # 只声明顶层 user_id 的话，pydantic 会静默丢掉 filters，
    # 服务端拿到空过滤条件就会报 "filters must contain at least one of..."。
    filters: dict[str, Any] | None = None
    user_id: str | None = None
    run_id: str | None = None
    top_k: int = 5
    limit: int | None = None
    output_format: str | None = None


@app.get("/health")
def health():
    """只报配置与初始化状态，不触发真实调用。"""
    return {
        "ok": True,
        "llm_configured": bool(os.environ.get("LLM_API_KEY")),
        "embedding_model": os.environ.get("EMBEDDING_MODEL", "text-embedding-v3"),
        "initialized": _memory is not None,
    }


@app.get("/v1/ping/")
def ping():
    """SDK 握手端点。

    `MemoryClient` 在第一次调用前会 ping 一次，不通过就抛
    "API Key is invalid"。自托管版不校验 key（内网服务），
    固定返回 ok 即可——**但必须实现**，否则首次调用直接失败。
    """
    return {"status": "ok"}


@app.post("/v1/memories/")
@app.post("/v3/memories/add/")
def add_memories(req: AddRequest):
    """写入记忆。

    **同时挂 v1 和 v3 两个路径**：mem0ai SDK 3.x 走 `/v3/memories/add/`，
    而平台文档和旧版 SDK 用 `/v1/memories/`。两个都开，
    换 SDK 版本时不用改服务端——这是"契约面窄、实现要宽"的典型场景。

    平台 API 的字段是 `messages` / `user_id` / `run_id`；
    mem0 OSS 的 `add()` 签名是 `(messages, user_id=..., run_id=...)`，直接转。
    """
    try:
        mem = get_memory()
        msgs = [m.model_dump() for m in req.messages]
        result = mem.add(msgs, user_id=req.user_id, run_id=req.run_id, metadata=req.metadata)
        log.info("写入完成 user=%s run=%s", req.user_id, req.run_id)
        return result
    except Exception as e:  # noqa: BLE001
        log.exception("写入失败")
        return JSONResponse(status_code=500, content={"error": f"{type(e).__name__}: {e}"})


@app.get("/v1/memories/")
@app.get("/v3/memories/")
def list_memories(
    user_id: str | None = Query(default=None),
    run_id: str | None = Query(default=None),
):
    """列出某个 user / run 的记忆。知识库后端用它做清理与调试。

    **mem0 2.x 的签名变了**：`get_all(filters={...})`，
    不再接受顶层的 `user_id=` / `run_id=`。传旧参数会抛
    "Top-level entity parameters ... are not supported"。
    """
    try:
        mem = get_memory()
        filters: dict[str, Any] = {}
        if user_id:
            filters["user_id"] = user_id
        if run_id:
            filters["run_id"] = run_id
        return mem.get_all(filters=filters or None)
    except Exception as e:  # noqa: BLE001
        return JSONResponse(status_code=500, content={"error": str(e)})


def _flatten_filters(filters: dict[str, Any] | None) -> dict[str, Any] | None:
    """把平台版的嵌套 filters 压平成 OSS 版能接受的形状。

    **为什么需要**：mem0 平台 API 支持
    ``{"AND": [{"user_id": "u"}, {"run_id": "r"}]}``，
    但 OSS 版的 ``search()`` 要求顶层直接给 ``user_id`` / ``run_id``，
    拿到 AND 会抛 "filters must contain at least one of: user_id, agent_id, run_id"。

    压平是安全的：OSS 内部本来就是把多个实体条件按 AND 处理，
    单层写法和嵌套 AND 语义等价。**只处理 AND**——OR 语义不同，
    压平会导致范围变大（本该受限的变成全量），宁可报错也不静默改变语义。
    """
    if not filters:
        return None

    if "AND" in filters and isinstance(filters["AND"], list):
        merged: dict[str, Any] = {}
        for part in filters["AND"]:
            if not isinstance(part, dict):
                continue
            # AND 里再套 OR 属于表达力超出 OSS 能力，明确报错比猜更安全
            if "OR" in part:
                raise ValueError("OSS 版不支持 AND 内嵌套 OR 的过滤条件")
            merged.update(part)
        return merged or None

    return filters


@app.post("/v1/memories/search/")
@app.post("/v3/memories/search/")
def search_memories(req: SearchRequest):
    """检索记忆。

    过滤条件优先用调用方传来的 `filters`（SDK 会带嵌套 AND/OR），
    没有时才从顶层 user_id / run_id 拼一个。**顺序不能反**：
    反过来会把 SDK 的嵌套条件压平成单层，导致 session 层检索变成全用户检索。
    """
    try:
        mem = get_memory()
        filters = req.filters
        if not filters:
            flat: dict[str, Any] = {}
            if req.user_id:
                flat["user_id"] = req.user_id
            if req.run_id:
                flat["run_id"] = req.run_id
            filters = flat or None

        filters = _flatten_filters(filters)

        top_k = req.limit or req.top_k or 5
        hits = mem.search(query=req.query, top_k=int(top_k), filters=filters)
        return hits
    except Exception as e:  # noqa: BLE001
        log.exception("检索失败")
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.delete("/v1/memories/")
@app.delete("/v3/memories/")
async def delete_memories(request: Request):
    """批量删除。平台 API 用 DELETE + body，FastAPI 要手动解析 body。"""
    try:
        body = await request.json()
        mem = get_memory()
        return mem.delete_all(
            user_id=body.get("user_id"),
            run_id=body.get("run_id"),
        )
    except Exception as e:  # noqa: BLE001
        return JSONResponse(status_code=500, content={"error": str(e)})


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("MEM0_PORT", "8888"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_config=None)
