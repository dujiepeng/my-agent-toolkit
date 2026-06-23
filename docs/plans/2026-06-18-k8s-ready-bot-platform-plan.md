# K8s Ready Bot 平台实施计划

> **给执行 Agent 的说明：** 按阶段顺序实施。每个阶段都要保持可独立部署、可验证，再进入下一阶段。

**目标：** 建设一个独立的、K8s-ready 的 Bot 平台，将管理面、LLM 运行时、数据面、工具执行层、workload 控制层和日志分析面拆开，同时保留 Docker Compose 作为第一版可运行部署方式。

**架构：** 先引入 `llm-runner`，再引入 `data-service`，然后引入 `bot-host`、`control-api`、`bot-factory`，最后补 `tool-runtime` / `mcp-gateway`、`log-service` / `analytics` 和 K8s-ready 打包。现有 `.agents/skills/wecom-cli-bot` 代码作为迁移来源和兼容目标，不作为新平台必须遵循的目录形态。

**技术栈：** Node.js 22、TypeScript ESM、现有 memory-service 继续使用 FastAPI/Python；第一阶段 Docker Compose，后续 Kubernetes manifests 或 Helm。

---

## Phase 0：基线和独立项目骨架

**目标：** 固化当前行为，定义接口，创建独立项目结构。

- [ ] 记录当前企业微信 Bot 消息流程、管理员认领流程、初始化引导流程、文档流程和记忆流程。
- [ ] 创建独立目录：
  - `services/llm-runner/`
  - `services/data-service/`
  - `services/bot-factory/`
  - `services/bot-host/`
  - `services/tool-runtime/`
  - `services/control-api/`
  - `services/log-service/`
  - `packages/contracts/`
  - `packages/shared/`
  - `deploy/compose/`
  - `deploy/k8s/`
- [ ] 在 `docs/contracts/` 下添加 API contract 草案：
  - `llm-runner`
  - `data-service`
  - `tool-runtime`
  - `log-service`
  - control API
- [ ] 增加 fixture 示例，覆盖 streaming chat、stop、session resume、document generation、initialization、tool call。
- [ ] 定义跨服务 `trace_id` 传递规则。
- [ ] 现有 template 测试继续作为兼容性测试：

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm test
npm run typecheck
```

## Phase 1：新增 llm-runner

**目标：** 将 provider CLI 执行能力从业务 Bot 容器中移出。

**文件和目录：**

- 创建 `services/llm-runner/`
- 创建 `services/llm-runner/src/`
- 创建 `deploy/compose/llm-runner.compose.yml`，或接入根 compose include
- 在 `packages/contracts/` 中创建共享 request/response 类型
- Runner API 稳定后，再从现有企业微信 Bot template 增加一个小兼容 adapter

**步骤：**

- [ ] 定义 `POST /v1/chat`，支持流式输出并返回 `run_id`。
- [ ] 定义 `POST /v1/stop`。
- [ ] 定义 `GET /health`。
- [ ] 在 `llm-runner` 内实现 `kiro-cli` adapter。
- [ ] 增加 runner 管理的进程超时、stop signal、按用户并发限制。
- [ ] 增加脱敏后的 run log。
- [ ] 每个 run 产生结构化事件，包含 `trace_id`、`run_id`、duration、status、error_code。
- [ ] 增加 runner auth volume 路径，例如 `/runner/auth/kiro`。
- [ ] 增加 runner workspace 路径，例如 `/runner/workspaces/<bot_id>/<user_id>`。
- [ ] 增加 client package 或 helper，供 bot-host/template 调用 `llm-runner`。
- [ ] 迁移期暂时保留直接 `kiro-cli` 模式。
- [ ] 使用 Docker Compose 验证：

```bash
docker compose up -d llm-runner
curl http://localhost:8200/health
```

## Phase 2：将 Runtime Session 移入 llm-runner

**目标：** 让 provider-specific session、active run、进程生命周期只存在于 `llm-runner` 内部。

- [ ] 增加 runner session 记录：
  - `runner_session_id`
  - `bot_id`
  - `user_id`
  - `conversation_id`
  - `runtime`
  - `provider_session_id`
  - `workspace_ref`
  - timestamps
- [ ] 增加 active run 记录：
  - `run_id`
  - `runner_session_id`
  - `bot_id`
  - `conversation_id`
  - `user_id`
  - `status`
  - `started_at`
  - `timeout_at`
  - `process_id`
- [ ] 增加 `GET /v1/sessions`。
- [ ] 增加 `POST /v1/sessions`，支持 new/reset/open。
- [ ] 先在 contract 中把 `/history`、`/open`、`/new`、`/name` 语义映射到 runner API。
- [ ] 明确同一个 `conversation_id + runtime` 同时最多一个 active run。
- [ ] 增加全局、runtime、Bot、user、conversation 维度并发限制。
- [ ] 增加测试，覆盖初始化向导中的数字回复在 runner session context 下不会丢失状态。
- [ ] Runner 模式稳定后，从 bot-host/template 中移除 Kiro-specific session parsing。

## Phase 3：新增 data-service

**目标：** 集中管理 Bot 数据、权限、会话映射、共享规则和工具策略。

**文件和目录：**

- 创建 `services/data-service/`
- 创建 `packages/contracts/data-service.ts` 或等价 OpenAPI schema
- 评估是复用还是包装 `services/memory-service/`

**数据 scope：**

- `system`
- `shared`
- `bot`
- `user`
- `session`

**步骤：**

- [ ] 定义 bot registry API：
  - create bot
  - get bot config
  - update bot config
  - list bots
- [ ] 定义 membership API：
  - add member
  - update member role
  - block member
  - list members
- [ ] 定义 admin state API：
  - create claim
  - verify claim
  - transfer admin
  - mark ready
- [ ] 定义 conversation API：
  - resolve conversation
  - create conversation
  - get conversation state
  - update conversation purpose/status
- [ ] 定义 file API：
  - read/write soul
  - read/write instructions
  - store generated documents
  - list shared docs
- [ ] 定义 history API：
  - append message
  - get recent conversation
  - list sessions
- [ ] 定义 prompt profile API：
  - get current profile version
  - get compiled profile by version
  - invalidate profile on config/tool/doc policy changes
- [ ] 定义 tool policy API：
  - list bot tools
  - enable/disable skill
  - enable/disable MCP server
  - publish skill/MCP definition version
  - rollback skill/MCP definition version
  - update tool permission policy
  - return secret references only, never raw secrets
- [ ] 定义 memory document API：
  - create memory source document
  - update memory source document as new version
  - list document versions
  - mark memory document version inactive
  - map search results to source document version
- [ ] 定义 log event sink：
  - accept structured events from services
  - keep audit source in data-service
  - forward analytics copy to log-service
- [ ] 为每个 scope 增加权限检查。
- [ ] 第一版将文件存储在 volume-backed directory。
- [ ] 初期继续使用现有 memory-service 作为向量后端。
- [ ] 增加 bot-host 对 data-service 的 client 支持。
- [ ] Data-service API 稳定后，为现有企业微信 Bot template 增加迁移 adapter。
- [ ] 验证删除并重建 Bot 容器不会丢失数据。

## Phase 4：新增 bot-host

**目标：** 提供独立企业微信消息入口，可承载一个或多个业务 Bot worker。

- [ ] 创建 `services/bot-host/`。
- [ ] 从 `data-service` 加载 bot registry、runtime config 和 prompt profile version。
- [ ] 按企业微信 Bot identity 路由消息。
- [ ] 每条消息都调用 `data-service.resolveMessageContext()`：
  - Bot 是否存在
  - 用户是否有权限
  - Bot 是否 ready
  - 当前 `conversation_id`
  - 当前 purpose/init 状态
  - 当前 prompt profile version
- [ ] 按版本缓存 compiled prompt profile，不每次完整读取 `soul.md` 和 `AGENTS.md`。
- [ ] 每次消息按 query 调用 data-service 搜索相关文档/记忆片段。
- [ ] 使用 data-service context 构造 prompt。
- [ ] 将 `llm-runner` 流式响应返回企业微信。
- [ ] 将消息、回复、产物和审计记录写回 data-service。
- [ ] 为每条消息产生结构化事件：
  - message received
  - context resolved
  - runner started/completed/failed
  - response sent
  - memory hit summary
  - tool call summary
- [ ] 在 bot-host 稳定前，保留现有 template bot 作为兼容路径。

## Phase 5：Control API

**目标：** 将 workload 生命周期操作集中到安全 API 后面。

- [ ] 创建 `services/control-api/`。
- [ ] 先实现 Compose control：
  - start bot
  - stop bot
  - restart bot
  - status
  - redacted logs
- [ ] 操作保持幂等。
- [ ] 防止覆盖 `.env`、admin state、history 和 auth paths。
- [ ] 为所有 control action 增加审计日志。
- [ ] 为所有 control action 发送结构化分析事件。
- [ ] API 形态保持与后续 Kubernetes 实现兼容。

## Phase 6：新增 bot-factory

**目标：** 提供一个默认管理 Bot，通过受控 API 创建和运维其他 Bot。

**文件和目录：**

- 创建 `services/bot-factory/`
- 不把 factory 主要实现为 Agent Skill。它是带企业微信管理入口的平台服务。
- 第一版不实现完整 Web 管理后台，但提供最小设置页，用于企业微信连接配置。管理 API 要预留给后续 Web 控制台或 CLI 复用。

**步骤：**

- [ ] 增加平台管理员认领流程。
- [ ] 定义 bot-factory management API：
  - create bot
  - update bot initial config
  - generate claim code
  - transfer admin
  - configure WeCom connection
  - test WeCom connection
  - query bot status
  - query redacted logs
  - query analytics summary
  - start/stop/restart through control API
- [ ] 增加 Bot 创建向导：
  - bot id/name
  - 企业微信凭证收集方式
  - 企业微信Bot ID
  - 企业微信 Secret
  - WebSocket/回调配置
  - 角色和目标
  - memory/docs 共享策略
  - runtime selection
  - 初始 tool policy
- [ ] 增加 secret 写入流程，确保原始 secret 不进入 LLM prompt。
- [ ] 增加最小设置页：
  - 输入平台 Bot ID
  - 输入 Secret
  - 输入 WebSocket/回调配置
  - 测试企业微信连接
  - 显示管理员认领码
  - 保存后不回显 Secret
- [ ] 为新创建的 Bot 增加认领码生成。
- [ ] 增加带脱敏的 status/log 命令。
- [ ] 增加基础 analytics 查询命令：
  - bot usage
  - error summary
  - slow runs
  - tool usage
- [ ] 通过 control API 增加 start/stop/restart 命令。
- [ ] 确保 bot-factory 不直接挂载 Docker socket。
- [ ] 不新增完整前端管理后台，避免第一版范围扩张。

## Phase 7：新增 tool-runtime / mcp-gateway

**目标：** 支持不同 Bot 使用不同 skill、MCP server 和平台内置工具，并把权限判断和实际执行拆开。

- [ ] 创建 `services/tool-runtime/`。
- [ ] 定义 `POST /v1/tools/call`。
- [ ] 定义 `GET /v1/tools`。
- [ ] 定义 `GET /health`。
- [ ] 接入 data-service 的 bot tool policy。
- [ ] 从 data-service 拉取 skill/MCP definition version 和 bot policy version。
- [ ] 支持 skill/MCP 版本变更后的热更新或受控重载。
- [ ] 支持平台内置 skill 执行。
- [ ] 支持 MCP server 连接和 tool 调用。
- [ ] 增加工具调用超时、限流、脱敏和审计。
- [ ] 为每次 tool call 发送结构化事件，包含 tool_id、version、duration、status、error_code。
- [ ] 对危险工具增加隔离或管理员确认策略。
- [ ] 第一版如需兼容 Kiro CLI 本地 MCP 配置，由 llm-runner 根据 data-service policy materialize per-bot MCP config。
- [ ] 长期方向保留 `kiro-cli -> mcp-gateway -> actual mcp servers` 的平台代理模式。

## Phase 8：新增 log-service / analytics

**目标：** 提供独立日志分析面，用于分析运行质量、成本、错误和用户行为，不替代 data-service 的业务事实和审计记录。

- [ ] 创建 `services/log-service/`。
- [ ] 定义 `POST /v1/events`。
- [ ] 定义 `GET /v1/query/events`。
- [ ] 定义 `GET /v1/query/metrics`。
- [ ] 定义 `GET /health`。
- [ ] 支持按 Bot、用户 hash、conversation、runtime、tool、时间范围查询。
- [ ] 增加事件脱敏规则，不默认保存完整 prompt、回复、文档或 Secret。
- [ ] 增加指标 rollup：
  - message count
  - run count
  - error count
  - latency p50/p95
  - timeout count
  - tool call count
  - memory hit count
- [ ] 第一版使用 SQLite/Postgres 保存结构化事件和 rollup。
- [ ] 后续预留 OpenTelemetry、Loki、ClickHouse、Elasticsearch 接入点。

## Phase 9：K8s-ready 打包

**目标：** 准备 Kubernetes 部署，但不把它作为第一阶段强依赖。

- [ ] 创建 `deploy/k8s/base/` manifests 或 Helm chart 草案。
- [ ] 映射服务：
  - `llm-runner` Deployment 或 StatefulSet
  - `data-service` Deployment/StatefulSet
  - `bot-factory` Deployment
  - `bot-host` Deployment 或 business bot Deployment
  - `tool-runtime` Deployment
  - `control-api` Deployment
  - `log-service` Deployment
- [ ] 使用 `Secret` 保存小体积敏感值。
- [ ] 使用 `PVC` 保存 Kiro CLI state、runner workspaces、file storage 和 database files。
- [ ] 使用 `ConfigMap` 保存非敏感 runtime config。
- [ ] 为 control API 增加窄权限 RBAC。
- [ ] 文档化从 Compose volume 迁移到 PVC 的方式。

## 验证矩阵

- [ ] 现有 template 兼容性测试通过。
- [ ] 现有 memory-service health check 通过。
- [ ] `llm-runner` health check 通过。
- [ ] `llm-runner` 可以执行 `kiro-cli whoami`。
- [ ] bot-host worker 可以通过 runner mode 完成初始化。
- [ ] 初始化向导中的数字回复不会重置到第一个问题。
- [ ] 每条消息都会通过 data-service resolve 权限、状态和 conversation。
- [ ] Bot-host 按 prompt profile version 缓存 `soul.md` 和 `AGENTS.md`。
- [ ] Shared docs 和 private docs 能正确隔离。
- [ ] Memory 检索结果都能回溯到 source document version。
- [ ] 更新 memory 会产生新文档版本和新索引版本，不覆盖旧版本。
- [ ] 重建 Bot 容器后，数据仍由 data-service 保留。
- [ ] Factory 创建新 Bot 时不会打印 secret。
- [ ] Control API 不能执行任意 shell 操作。
- [ ] BotA 不能调用未授权给自己的 skill/MCP。
- [ ] Tool-runtime 调用结果和审计记录会写回 data-service。
- [ ] Log-service 可以按 `trace_id` 查询一次消息从 bot-host 到 llm-runner/tool-runtime 的完整脱敏事件链。
- [ ] Log-service 不保存完整 prompt、回复、文档或 Secret。

## Rollout 策略

1. 当前 PRD Bot 继续运行在现有 template 上。
2. 并行新增独立 `llm-runner`，先用单独 client 验证。
3. 新增独立 `data-service`。
4. 新增独立 `bot-host`，先迁移一个 Bot。
5. 新增 `control-api`，把启停和日志收敛到受控接口。
6. 等 data-service 持有 bot registry、admin state 和 membership 后，再增加 `bot-factory`。
7. 新增 `tool-runtime` / `mcp-gateway`，支持 per-bot skill/MCP。
8. 新增 `log-service` / `analytics`，分析运行质量、成本、错误和用户行为。
9. 等 Compose contract 稳定后，再生成 K8s manifests。

## 风险

- Kiro CLI state 格式变化可能影响 runner auth。
- 未来不同 CLI provider 的 streaming 行为可能不一致。
- 中央 data-service 会成为关键依赖。
- Factory/control API 如果权限检查过宽，会带来高风险。
- Tool-runtime 如果缺少隔离，会扩大 MCP/skill 的执行风险。
- Log-service 如果脱敏不严格，会扩大 prompt、回复和用户行为数据的暴露面。
- 过早迁移 Kubernetes 可能拖慢核心服务边界建设。
