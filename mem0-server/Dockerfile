# 自托管 mem0 服务镜像。
#
# **为什么自己构建**：官方 `mem0/mem0-api-server` 只发布 linux/arm64，
# 本机（Windows + amd64）拉不下来。而这个服务本身只是
# 「mem0 OSS + 一个 FastAPI 壳」，自己构建反而更可控。
#
# 构建：
#   docker build -t kh-mem0:local .
# 运行（由 docker-compose 负责注入环境变量与卷）。

FROM python:3.12-slim

WORKDIR /app

# 先装依赖，让这一层能命中缓存
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py ./

# 数据目录：Qdrant 本地文件模式把向量落在这里，挂卷后重启不丢
RUN mkdir -p /app/data/qdrant

EXPOSE 8888

# 不用 uvicorn CLI 而用 python main.py：
# 保持和本地开发完全一致的启动路径，避免「本地能跑容器不能跑」
CMD ["python", "main.py"]
