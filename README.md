<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

knowledge-hub 后端：NestJS 11 + TypeScript，提供文档生命周期管理、RBAC 权限、RAG 智能问答（混合检索 + Agent）与知识图谱，共 14 个 Controller / 100 个接口。

## 架构

```text
┌─ 客户端 ───────────────────────────────────────────────┐
│  React 19 前端  :5173      /api 代理 → 127.0.0.1:3000  │
└───────────────────────────┬────────────────────────────┘
                            │ HTTP / SSE
┌─ 接入层 · NestJS 11 ──────▼────────────────────────────┐
│  全局 Guard：JWT → Roles → Permissions（9 个权限码）    │
│  document      CRUD / 状态机 / 审核 / 分享 / 版本       │
│  ai            /ai/chat · /ai/chat/stream               │
│  graph / search       auth / user / team / notification │
└───────────────────────────┬────────────────────────────┘
                            ▼
┌─ 业务与 AI ────────────────────────────────────────────┐
│  Agent 编排   createAgent + 4 工具                      │
│               retrieve / rewrite / graph / web          │
│  混合检索     BM25(ik) + kNN → RRF(k=60) → rerank      │
│               → minScore 0.4 → top5                     │
│  三层记忆     Redis 热窗口 → PG 会话 → Mem0             │
│  离线评测     9 条金标 / 5 个 suite / 9 个评估器        │
└───────────────────────────┬────────────────────────────┘
                            │ 发布 / 归档事件
┌─ 异步管线 · RabbitMQ ─────▼────────────────────────────┐
│  3 交换机 / 3 队列                                      │
│  rag.reindex · search.index · kg.graph                  │
│  → PipelineOrchestrator：切分 512/64 → embedding → 索引 │
└───────────────────────────┬────────────────────────────┘
                            ▼
┌─ 存储层 ───────────────────────────────────────────────┐
│  PostgreSQL  19 表，元数据 / 权限                       │
│  MongoDB     document_content 正文                      │
│  ES          kh_chunk(dense_vector 1024) / kh_document  │
│  Neo4j       Document → Chunk → Entity                  │
│  Redis       记忆热窗口 / 验证码                        │
│  RustFS      S3 兼容，文件与图片                        │
└────────────────────────────────────────────────────────┘

外部依赖：DashScope（text-embedding-v3 · qwen3-rerank · qwen-plus）
          Bocha 联网搜索 · MinerU 文档解析 · Langfuse 可观测
```

**说明**：向量存在 Elasticsearch `kh_chunk.embedding`（dense_vector，1024 维 cosine），PostgreSQL 不承担向量检索。

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

### 已知问题：`test:e2e` 跑不起来

`test/app.e2e-spec.ts` 是 NestJS 脚手架自带的模板测试（2026-08-07 建立后未再改动），
它 `import { AppModule }` 会连带加载 `ai` 包——而 `ai@7` 是 **ESM-only**，
在 Jest 的 CJS 环境里直接报 `SyntaxError: Cannot use import statement outside a module`。

**这是测试脚手架的环境问题，不是应用问题。** 应用本身用真实 HTTP 验证过：

```bash
$ curl -s http://127.0.0.1:3000/                 # Hello World!
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/metrics   # 200
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/documents # 401（无 token）
```

要修就得把 jest 换成 ESM 模式（`extensionsToTreatAsEsm` + `transform` 全改），
或者给 `ai` 包写 CJS 垫片——**收益不抵成本**，真正的端到端验证走 Playwright
（见下文「端到端验证」）。

---

## 可观测性

三层，各答一个问题，不是「装了三套工具」：

| 层 | 组件 | 回答什么 |
|---|---|---|
| 链路 | **Langfuse** | 这次答错是检索错还是生成错 |
| 指标 | **Prometheus + Grafana** | 整体在变慢吗 / 检索质量在退化吗 |
| 错误 | **Sentry** | 哪一步崩了 |

### 指标（`GET /metrics`）

零依赖手写（`src/observability/metrics.ts`），不引 prom-client——这个项目已经跑 17 个容器，
为埋点再栽一棵依赖树不划算。

| 指标 | 类型 | 说明 |
|---|---|---|
| `kh_http_requests_total` | counter | 按 method / route / status 切分 |
| `kh_http_request_duration_seconds` | histogram | 算 P50/P95/P99 |
| `kh_llm_calls_total` | counter | 大模型调用次数，按 ok/error |
| `kh_llm_tokens_total` | counter | token 用量，按 input/output |
| `kh_retrieval_total` | counter | **检索 verdict：ok / insufficient / error** |
| `kh_refresh_inflight` | gauge | 在途请求数 |

`kh_retrieval_total` 是最该盯的一个：接口 200 不代表答得好，
**insufficient 占比升高**说明语料缺或切分/向量化退化，这是接口成功率永远发现不了的问题。

**注意**：`streamUsage` 必须为 `true`（`ai-stream.service.ts`），
否则流式响应不回 usage，`kh_llm_tokens_total` 会永远是空。

### Grafana

```bash
$ GRAFANA_PASS=<本地 Grafana 口令> node deploy/grafana/build-dashboard.mjs
```
打开 → http://127.0.0.1:13000/d/knowledge-hub

和 loyalty-console 共用同一套 Prometheus/Grafana，靠指标前缀区分（`kh_*` vs `mc_*`）。

### Sentry

前端 DSN 走 `.env.local`（不提交），后端异常目前只进日志。
联调脚本故意抛的错误前缀是 `e2e-sentry-verify` / `kh-probe-`，已在 `ignoreErrors` 里排除，
避免验证链路时触发告警邮件。

---

## 端到端验证

```bash
# 有头浏览器 + 真实后端 + 真实模型，10 项断言
$ node scripts/flow-rag-deep.mjs

# mem0 跨会话记忆：会话 A 说偏好 → 等 35s → 会话 B 验证召回
$ node scripts/test-mem0-e2e.mjs
```

`flow-rag-deep.mjs` 验证的六件事：

1. 登录 → 进入 AI 智能问答
2. 提问「加签流程是什么」→ 等到回答稳定（**盯 `.kh-chat-log`，不盯整页**）
3. 回答带引用角标 `.kh-cite-inline`
4. 会话列表 `.kh-chat-session-item` 有数据
5. **防幻觉**：问「公司年会在几月办」→ 必须明确回答「知识库中没有」
6. 无致命 JS 错误

第 5 条比「答对了」更有价值：答对可能靠模型常识，拒答只能靠系统约束。


## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ pnpm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
