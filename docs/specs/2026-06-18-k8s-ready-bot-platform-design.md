# K8s Ready Bot 平台设计

## 目标

在当前仓库中建设一个独立的 Bot 平台。现有 `.agents/skills/wecom-cli-bot` 模板作为迁移来源和兼容目标保留，但新平台不再受 Agent Skill 目录形态约束。

平台需要拆出清晰的服务边界：

- `bot-factory`：用于创建、引导和运维 Bot 的管理入口。
- `llm-runner`：与具体 LLM/CLI 类型解耦的运行时网关。
- `data-service`：Bot 配置、文件、历史、记忆元数据和共享规则的事实来源。
- `bot-host`：轻量企业微信消息桥接层，可承载一个或多个业务 Bot worker。
- `tool-runtime` / `mcp-gateway`：执行不同 Bot 被授权使用的 skill、MCP 和平台内置工具。
- `control-api`：受限 workload 生命周期控制层，屏蔽 Docker Compose 和 Kubernetes 的差异。
- `log-service` / `analytics`：收集结构化日志、事件和指标，用于分析运行质量、成本、错误和用户行为。

第一阶段仍以 Docker Compose 友好为目标，但服务边界必须能自然迁移到后续 Kubernetes 部署。

## 非目标

- 第一阶段不直接迁移到 Kubernetes。
- 不立即实现多个 LLM provider；先支持 `kiro-cli`。
- 不给面向聊天的 Bot 直接挂载 Docker socket 或 cluster-admin 权限。
- 不把真实企业微信 Secret、Kiro 认证材料、LLM provider 凭证写入 Git。
- 不允许普通业务 Bot 读取或修改其他 Bot 的私有数据。
- 不强制新平台代码继续放在 `.agents/skills/` 下。

## 目标架构

```text
bot-factory
  - 企业微信管理入口
  - 引导 Bot 创建和运维操作
  - 调用 data-service 和 control API
  - 可选调用 llm-runner 辅助生成配置

bot-host / business-bot worker
  - 接收企业微信消息
  - 执行 Bot 级管理员和用户交互规则
  - 通过 data-service 读写状态
  - 将 prompt 发送给 llm-runner
  - 需要工具时调用 tool-runtime

llm-runner
  - 暴露与 provider 无关的 chat/stop/session API
  - 持有 CLI/runtime 认证、session、进程生命周期、超时和日志
  - 第一阶段适配 kiro-cli，后续再扩展其他 provider

data-service
  - 持有 Bot registry、config、soul、instructions、admin state、membership、conversation、history、docs、tool policy 和共享元数据
  - 暴露带 scope 的数据 API
  - 使用文件存储、数据库和向量搜索后端

tool-runtime / mcp-gateway
  - 执行 skill、MCP tool 和平台内置工具
  - 负责工具超时、限流、脱敏、审计和危险动作隔离
  - 不决定某个 Bot 是否有权限使用工具，权限由 data-service 提供

control-api
  - 暴露 start/stop/restart/status/logs 等 workload 操作
  - 第一阶段适配 Docker Compose
  - 后续适配 Kubernetes API 和窄权限 RBAC

log-service / analytics
  - 收集 bot-host、llm-runner、tool-runtime、data-service、control-api 的结构化事件
  - 支持错误分析、响应耗时、token/调用成本、工具调用、用户活跃和 Bot 质量分析
  - 不作为业务事实来源，不保存原始 secret，不默认保存完整 prompt

memory/vector backend
  - 初期保持独立服务
  - 后续可成为 data-service 的后端能力
```

## 核心服务

### bot-factory

`bot-factory` 是管理面 Bot，不是普通业务 Bot。

第一版 `bot-factory` 以企业微信管理入口和管理 API 为主，不实现完整 Web 管理后台。但可以提供一个最小设置页，用于输入和校验企业微信连接配置，例如企业微信Bot ID、Secret、回调/WebSocket 配置和认领码展示。后续如果需要完整 Web 控制台，应复用同一套管理 API，而不是让前端直接访问底层 Docker、Kubernetes、Secret、provider auth 或数据存储。

它可以：

- 引导操作者创建 Bot。
- 通过 `data-service` 创建和更新 Bot 记录。
- 通过受控 API 生成管理员认领码。
- 通过受限 control API 启动、停止、重启 Bot workload。
- 配置 Bot 的 soul、instructions、memory/docs 共享策略和初始 tool policy。
- 展示状态和脱敏后的日志摘要。
- 暴露可复用的管理 API，预留给后续 Web UI 或 CLI 使用。
- 提供最小设置页，降低企业微信Bot ID、Secret、WebSocket/回调配置的输入错误率。

它不应该：

- 在面向聊天的容器中直接挂载 Docker socket。
- 执行任意 shell 命令。
- 读取或打印原始 `.env`、provider auth、Kiro state。
- 绕过 data-service 的共享和权限规则。
- 在第一版引入复杂 Web 管理后台，避免偏离核心服务边界建设。

最小设置页边界：

- 只支持创建/编辑企业微信连接配置、触发连接测试、生成/展示管理员认领码。
- Secret 输入后只写入受控 secret flow，不在页面回显，不进入 LLM prompt。
- 页面不提供 soul、memory、skill/MCP、日志分析、运行趋势等完整后台能力。
- 页面调用 `bot-factory` management API，不直接访问 data-service、control-api 或底层存储。

### bot-host 和业务 Bot worker

`bot-host` 是企业微信消息入口和业务编排层。它可以是一个 multi-bot host，也可以先兼容一个容器一个业务 Bot 的形态。

它负责：

- 接收企业微信消息。
- 解析 `bot_id`、`wecom_user_id`、`chat_id`、`thread_id`、`message_id`。
- 向 data-service resolve 用户权限、Bot 状态、初始化状态和 `conversation_id`。
- 获取 prompt profile 版本、最近历史、相关文档片段、记忆片段和 tool policy。
- 组装 prompt 并调用 llm-runner。
- 必要时通过 tool-runtime 执行被授权的 skill/MCP。
- 将回复发回企业微信。
- 将消息、回复、产物和审计事件写回 data-service。

它不应该：

- 直接执行 `kiro-cli` 或其他 provider CLI。
- 长期保存 session、管理员状态、成员关系或共享文档。
- 直接读写共享文件目录、向量数据库或 Secret。
- 直接管理 Docker/Kubernetes workload。

### data-service

`data-service` 是平台数据面、事实来源和权限边界。它不是单纯的文档存储，也不等同于向量数据库。

它负责：

- Bot registry、Bot 配置、runtime policy。
- Bot 管理员、成员关系、认领状态、管理员转移状态。
- 初始化引导状态和 Bot ready 状态。
- 业务 conversation、message history、session metadata。
- `soul.md`、`AGENTS.md`、instructions、生成文档、附件、共享资料和 memory source docs。
- shared/private scope 权限规则和文档版本。
- skill/MCP registry、Bot tool policy、tool secret reference、policy version。
- 审计记录。
- memory/vector backend 的统一访问入口。

它回答这些问题：

```text
这个 Bot 是否存在？
谁是管理员？
这个企业微信 userId 能不能使用这个 Bot？
这条消息属于哪个 conversation_id？
Bot 是否已经完成初始化？
Bot 的 soul/AGENTS.md 当前版本是多少？
Bot 可以访问哪些共享文档？
Bot 可以使用哪些 skill/MCP？
```

### control-api

`control-api` 是 workload 生命周期控制层。`bot-factory` 可以调用它，但不直接获得底层 Docker socket 或 Kubernetes 高权限。

Compose-first control API：

```text
POST /v1/control/bots/{bot_id}/start
POST /v1/control/bots/{bot_id}/stop
POST /v1/control/bots/{bot_id}/restart
GET  /v1/control/bots/{bot_id}/status
GET  /v1/control/bots/{bot_id}/logs
```

它负责：

- 启动、停止、重启 Bot workload。
- 查询状态和脱敏日志。
- 保证操作幂等。
- 避免覆盖 `.env`、admin state、history、auth path 和 data-service 中的事实数据。
- 记录 control action 审计日志。

第一阶段它可以适配 Docker Compose。后续迁移 K8s 时，对上层 API 不变，内部改为调用 Kubernetes API。

### log-service / analytics

`log-service` 是分析面，不是业务事实来源。`data-service` 保存需要强一致的业务记录和审计记录；`log-service` 保存用于分析的结构化事件、指标和脱敏日志。

它负责：

- 收集来自 `bot-host`、`llm-runner`、`tool-runtime`、`data-service`、`control-api`、`bot-factory` 的结构化事件。
- 分析 Bot 使用量、用户活跃、响应耗时、错误率、超时率、stop/cancel、tool 调用、memory 命中、文档引用、运行成本。
- 保存可查询的 request/run/tool/error 事件。
- 提供按 Bot、用户、conversation、runtime、tool、时间范围聚合的分析查询。
- 支持脱敏、采样、保留周期和导出。

它不应该：

- 替代 data-service 保存业务事实。
- 保存原始 Secret、provider auth、企业微信 Secret。
- 默认保存完整 prompt、完整回复或完整文档内容。
- 参与权限决策、session 决策或 tool 执行决策。

推荐事件模型：

```text
log_events
  event_id
  event_type
  trace_id
  bot_id
  user_id_hash
  conversation_id
  run_id
  service
  severity
  duration_ms
  status
  error_code
  metadata
  created_at

metrics_rollups
  scope
  scope_id
  metric_name
  bucket_start
  bucket_size
  value
```

关键规则：

- 所有跨服务调用带 `trace_id`。
- 日志只保存脱敏后的摘要和 metadata，原始内容回到 data-service 按权限查询。
- 审计事件仍写 data-service；log-service 可以接收审计事件副本用于分析。
- 第一版可以用 SQLite/Postgres 存结构化事件，后续可接 OpenTelemetry、Loki、ClickHouse 或 Elasticsearch。

### llm-runner

`llm-runner` 是通用运行时网关。Bot 容器不需要知道底层 provider 是 Kiro、Codex、Claude，还是 HTTP LLM。

外部 API 形态：

```text
POST /v1/chat
POST /v1/stop
GET  /v1/sessions
POST /v1/sessions
GET  /health
```

稳定外部契约：

```text
prompt in -> stream out
stop by run_id
runtime session by bot_id + user_id + conversation_id + runtime
```

Provider 相关逻辑只存在于 runner adapter 内部：

```text
kiro-cli adapter
future codex adapter
future claude adapter
future HTTP model adapter
```

`llm-runner` 管的是 runtime session，不管 Bot 和企业微信用户的业务映射。业务映射由 data-service 决定。

Runtime session 是热数据，且会同时存在多组：

```text
用户A + BotA + conversation_1 + kiro -> runner_session_1
用户B + BotB + conversation_2 + kiro -> runner_session_2
用户A + BotA + init flow + kiro -> runner_session_3
```

并发控制也属于 `llm-runner`：

```text
same conversation_id + runtime: at most 1 active run
same bot_id: max N active runs
same user_id: max M active runs
same runtime: max K active runs
```

### tool-runtime / mcp-gateway

不同 Bot 可能启用不同 skill、MCP server 或平台内置工具。这里需要拆成两层：

```text
data-service 管配置和权限
tool-runtime / mcp-gateway 管实际执行
```

Skill 和 MCP 可能随时变化，因此不能由 `bot-factory` 固化。`bot-factory` 只在 Bot 创建时设置初始策略；后续启用、禁用、升级、回滚和授权变化都应进入 data-service 的版本化 registry/policy。

`data-service` 保存：

- Bot 启用了哪些 skill。
- Bot 能访问哪些 MCP server。
- 哪些 tool 需要管理员确认。
- 哪些 tool 可以读取 private docs 或写 shared docs。
- tool secret 的引用，不保存到 prompt。
- skill/MCP 定义版本、Bot policy 版本和变更审计。

`tool-runtime` / `mcp-gateway` 执行：

- 连接 MCP server。
- 调用 MCP tool。
- 执行平台内置 skill。
- 执行超时、限流、脱敏、隔离和审计。

第一版如果 Kiro CLI 只能读取本地 MCP 配置，可以由 llm-runner 根据 data-service 的 tool policy materialize per-bot MCP config；长期方向是通过平台代理 MCP：

```text
kiro-cli -> mcp-gateway -> actual mcp servers
```

## 数据和 Session 边界

### 业务会话归 data-service

`data-service` 决定“这是谁和哪个 Bot 的哪段业务对话”。

推荐模型：

```text
bots
  bot_id
  name
  wecom_bot_id
  status
  runtime_policy

bot_members
  bot_id
  wecom_user_id
  role
  status

bot_admins
  bot_id
  wecom_user_id
  role
  claimed_at
  transferred_at

conversations
  conversation_id
  bot_id
  channel
  wecom_user_id
  wecom_chat_id
  thread_id
  purpose
  status
```

### Runtime session 归 llm-runner

`llm-runner` 决定“某段业务对话在某个 LLM runtime 下如何续上下文”。

推荐模型：

```text
runtime_sessions
  runner_session_id
  bot_id
  user_id
  conversation_id
  runtime
  provider
  provider_session_id
  workspace_ref
  status
  last_active_at
  created_at
  updated_at

active_runs
  run_id
  runner_session_id
  bot_id
  conversation_id
  user_id
  status
  started_at
  timeout_at
  process_id
```

### Prompt profile 缓存

每条消息都必须经过 data-service 做轻量 resolve：

- Bot 是否存在。
- Bot 是否 ready。
- 用户是否有权限。
- 当前 `conversation_id` 是什么。
- 当前 purpose/init 状态是什么。
- 当前 prompt profile 版本是什么。

但不需要每次完整读取 `soul.md`、`AGENTS.md` 和大文档。`soul`、`instructions`、`agents`、tool policy、shared docs index 应版本化，`bot-host` 可以按版本缓存 compiled prompt profile。

相关文档和记忆检索通常每次执行，但返回命中的片段，不返回全文。

### Memory 必须有文档来源和版本号

Memory 不能只有向量索引。只要启用 memory，就必须同时存在可审阅、可版本化的 source document。

推荐模型：

```text
memory_documents
  memory_doc_id
  scope
  owner_id
  title
  version
  content_ref
  status
  created_at
  updated_at

memory_chunks
  chunk_id
  memory_doc_id
  version
  content_hash
  embedding_ref
  metadata

memory_indexes
  index_id
  scope
  version
  backend
  status
```

规则：

- 写入 memory 时，先写 source document，再生成 chunk 和 embedding。
- 检索结果必须能回溯到 `memory_doc_id + version`。
- 更新 memory 时产生新版本，不直接覆盖旧版本。
- 删除或失效 memory 时，source document 和 index 状态都要更新。
- Bot 引用 memory 时按 scope 和版本权限过滤。

## 存储后端

第一版独立项目结构建议：

```text
services/
  llm-runner/
  data-service/
  bot-factory/
  bot-host/
  tool-runtime/
  control-api/
  log-service/
packages/
  contracts/
  shared/
deploy/
  compose/
  k8s/
```

现有 skill template 后续可以变成该平台的 exporter 或 client，但不应该决定平台内部服务布局。

后端组件：

```text
metadata DB
  SQLite/Postgres
  保存 Bot、用户、conversation、权限、配置、审计

file storage
  Volume/PVC/S3/MinIO
  保存 soul.md、AGENTS.md、生成文档、附件、共享资料

memory/vector backend
  当前 memory-service + ChromaDB
  后续可换 Qdrant / pgvector

secret store
  Compose 下可以是 env 文件或 secret volume
  K8s 下是 Secret
  Kiro CLI state 用 PVC，不用 Secret

runner workspace
  llm-runner 使用
  保存每个 Bot/User/Conversation 的运行时工作目录

log/analytics storage
  SQLite/Postgres first, later ClickHouse/Loki/Elasticsearch/OpenTelemetry
  保存结构化事件、脱敏日志摘要、指标 rollup
```

## LLM Runner 运行时模型

初始运行时配置：

```yaml
default_runtime: kiro
runtimes:
  kiro:
    type: cli
    command: kiro-cli
    args: ["chat", "--no-interactive", "--trust-all-tools", "{{prompt}}"]
    input_mode: arg
    session_strategy: kiro-chat
    auth_dir: /runner/auth/kiro
```

Runner 将平台 session 映射到 provider session：

```text
runner_session_id
bot_id
user_id
conversation_id
runtime
provider_session_id
workspace_ref
created_at
updated_at
```

Provider 认证由 runner 持有。Docker Compose 下可以使用 volume 或宿主机 bind mount。Kubernetes 下应使用 PVC 保存 Kiro 这类可变 CLI 状态，例如 SQLite 认证数据库。

第一版建议 `llm-runner` 在 Compose 下按 runtime pool 单副本运行。Session metadata 可持久化到 SQLite，active process 属于 best-effort 热状态；runner 重启后，未完成 run 标记为 `interrupted`。

## Data Service 存储模型

第一版 data-service 可以务实实现：

- SQLite 或 Postgres 存 metadata。
- 本地 volume 存文件 blob。
- 继续使用现有 memory-service 做向量搜索。

后续 K8s 部署可映射为：

- Postgres 存 metadata。
- PVC 或 S3 兼容对象存储保存文件。
- Vector DB 或 memory-service backend 处理 embedding。

关键规则是：Bot 容器本地文件系统不是事实来源。

后续 K8s control API 可使用 Kubernetes API，并配置窄权限 RBAC：

- 只管理 Bot 平台 namespace 内 workload。
- 创建和更新 Bot 专属 Secret、ConfigMap。
- 读取 pod 状态和日志。
- 不允许 privileged pod。
- 不使用 hostPath mount。
- 不允许集群范围 Secret 访问。

## Kubernetes 映射

该设计后续应能直接映射到 Kubernetes：

```text
bot-factory   -> Deployment + Service
llm-runner    -> Deployment or StatefulSet + Service + PVC
data-service  -> Deployment/StatefulSet + Service + DB/PVC
bot-host      -> Deployment, or Deployment per business bot
tool-runtime  -> Deployment + Service
control-api   -> Deployment + Service + narrow RBAC
log-service   -> Deployment + Service + DB/PVC
memory        -> existing service or data-service backend
```

K8s 对象使用方式：

- `Secret`：小体积敏感值，例如企业微信 Secret、provider API key。
- `ConfigMap`：非敏感运行时配置和 Bot 模板。
- `PVC`：可变目录、Kiro CLI state、文件存储、缓存和数据库文件。
- `Service`：组件之间稳定的内部 URL。
- `RBAC`：限制 factory/control API 的权限范围。

Kiro CLI state 应使用类似 PVC 的文件系统路径，而不是 K8s Secret，因为它是可变目录或数据库，不是单个静态 token。

## 迁移策略

Phase 1 引入独立 `llm-runner`，同时保持当前 PRD Bot 继续运行：

```text
bot-host or adapter -> llm-runner -> kiro-cli
```

Phase 2 引入独立 `data-service` 作为事实来源：

```text
bot-host -> data-service for config/history/docs
llm-runner -> data-service for workspace materialization
```

Phase 3 引入 `bot-host`，让业务 Bot 变成消息入口和编排层：

```text
wecom -> bot-host -> data-service + llm-runner
```

Phase 4 引入 `control-api`，把启动、停止、重启、状态和日志收敛到受控接口。

Phase 5 引入 `bot-factory`：

```text
factory-bot -> data-service + control API -> create/manage bots
```

Phase 6 引入 `tool-runtime` / `mcp-gateway`，把 Bot 的 skill/MCP 权限和实际执行拆开。

Phase 7 引入 `log-service` / `analytics`，为运行质量、成本、错误和用户行为提供分析能力。

Phase 8 在 Compose 服务契约稳定后，再补 Kubernetes manifests 或 Helm。

## 安全规则

- 面向聊天的服务不获得任意 shell 执行能力。
- 普通 Bot 不获得 Docker socket 或 Kubernetes 写权限。
- Secret 通过受控 API 或部署工具写入，不通过模型输出。
- Provider auth 路径永不进入 prompt。
- `llm-runner` 日志入库或展示前必须脱敏。
- `data-service` 对每次读写执行 scope 校验。
- `tool-runtime` 对工具调用执行超时、限流、脱敏、隔离和审计。
- `log-service` 只保存脱敏事件和指标，不默认保存完整 prompt、回复、文档或 Secret。
- Bot 创建和管理员重置操作必须审计。

## 待定问题

- 第一版 `data-service` 是扩展现有 memory-service，还是作为新服务独立实现。
- 业务 Bot 是一个容器一个 Bot，还是使用 multi-bot host。
- Kiro workspace 是每次运行完整 materialize，还是按 bot/user 持久化。
- 第一版 MCP 是由 `llm-runner` materialize per-bot 配置，还是直接走 `mcp-gateway` 代理。
