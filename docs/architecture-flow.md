# My Agent Toolkit 架构流程图

本文基于当前仓库结构、`README.md`、`deploy/compose/docker-compose.yml` 和各服务入口代码整理，用于快速理解这个项目的运行链路。

## 项目定位

`my-agent-toolkit` 是一个个人 AI Agent 技能与企业微信 Bot 平台仓库。它包含两类内容：

- `.agents/skills/`：给 Codex/Kiro/Kimi/Claude 等 Agent 使用的技能说明与模板。
- `services/`：企业微信 Bot 平台的多服务实现，包括控制面、消息接入、LLM 执行、状态存储、日志、能力安装和记忆服务。

## 总体服务拓扑

```mermaid
flowchart LR
  web[浏览器 / WebUI] --> control[control-api<br/>:8600]
  wecom[企业微信长连接] --> worker[wecom-worker<br/>:8401]

  control --> botapi[bot-api<br/>:8400]
  control --> data[data-service<br/>:8300]
  control --> logs[log-service<br/>:8500]
  control --> cap[capability-runner<br/>:8700]

  botapi --> handler[共享 messageHandler]
  worker --> handler

  handler --> data
  handler --> llm[llm-runner<br/>:8200]
  handler --> logs
  handler --> cap

  cap <--> runtime[(runtime/bots<br/>Bot 私有 workspace)]
  llm --> runtime
  llm --> relay[宿主机 Kiro relay / CLI<br/>:8210]

  mcp[mcp-service<br/>可选] --> data
  mcp --> memory[memory-service<br/>:8100 可选]
  llm -. MCP 工具调用 .-> mcp

  data --> dataDb[(SQLite<br/>data-service.db)]
  logs --> logDb[(SQLite<br/>log-service.db)]
  memory --> vector[(ChromaDB / fastembed<br/>向量记忆)]
```

说明：

- 基础 Compose 拓扑包含 `control-api`、`bot-api`、`data-service`、`log-service`、`llm-runner`、`capability-runner`。
- `wecom-worker` 在 `wecom` profile 下单独启动，避免开发环境重复抢占真实企业微信长连接。
- `mcp-service` 和 `memory-service` 是可选的工具/记忆链路，源码已存在，但不在当前基础 Compose 拓扑中。

## 核心消息处理流程

```mermaid
flowchart TD
  start{消息来源}

  start -->|平台模拟 / WebUI 触发| webui[浏览器 / WebUI]
  webui --> control[control-api]
  control --> botapi[bot-api]

  start -->|真实企微消息| wecom[企业微信长连接]
  wecom --> worker[wecom-worker]

  botapi --> handler[messageHandler]
  worker --> handler

  handler --> context[解析 bot、channel、conversation、初始化状态]
  context --> dataRead[读取 data-service<br/>bot / admin / soul / agents / roles / docs / memory metadata]
  dataRead --> command{是否为控制命令}

  command -->|管理员认领 / 初始化 / 会话 / capability 命令| stateWrite[写入 data-service<br/>必要时调用 capability-runner]
  stateWrite --> reply1[生成可见回复]

  command -->|普通对话| prompt[构建 Prompt<br/>注入 soul、agents、文档和记忆上下文]
  prompt --> llm[调用 llm-runner<br/>mock 或 kiro]
  llm --> output[处理模型输出]
  output --> pending{是否生成配置或业务文档}
  pending -->|是| pendingDocs[写入 pending/generated docs<br/>等待确认或应用]
  pending -->|否| noDocs[直接回复]
  pendingDocs --> reply2[返回确认提示]
  noDocs --> reply2

  reply1 --> logs[写 chat/audit/tool 日志]
  reply2 --> logs
  logs --> done[返回 WebUI 或企业微信]
```

关键点：

- `bot-api` 和 `wecom-worker` 不各自实现一套业务逻辑，而是共享 `services/bot-host/src/messageHandler.ts`。
- 运行状态不保存在接入进程内，关键状态统一进入 `data-service`。
- `llm-runner` 只负责把请求交给具体 runtime，不直接管理 bot 配置或能力安装。

## 控制面流程

```mermaid
flowchart TD
  admin[管理员打开 WebUI] --> control[control-api]

  control --> bots[Bot 管理<br/>创建、编辑、重置管理员]
  control --> roles[角色管理<br/>role.md、role questions]
  control --> docs[文档管理<br/>global docs、role docs、business docs]
  control --> caps[能力管理<br/>env、skills、MCP、policy]

  bots --> data[data-service]
  roles --> data
  docs --> data
  caps --> data
  caps --> cap[capability-runner]

  control --> audit[log-service<br/>记录审计事件]

  cap --> workspace[(runtime/bots/{botId}<br/>私有 workspace)]
  data --> sqlite[(data-service.db)]
```

控制面的职责边界：

- `control-api` 提供页面和管理 API，并把多数结构化状态写入 `data-service`。
- 能力安装/删除由 `capability-runner` 执行，目标是每个 bot 的私有 workspace。
- 环境变量真实值不进入 Prompt、Memory、Soul、Agents 或普通文档，只在 runtime 执行时临时注入。

## Bot 私有能力流程

```mermaid
sequenceDiagram
  participant Admin as 管理员 / WebUI
  participant Control as control-api
  participant BotApi as bot-api / messageHandler
  participant Data as data-service
  participant Cap as capability-runner
  participant Workspace as runtime/bots/{botId}
  participant LLM as llm-runner

  Admin->>Control: 安装 skill / MCP 或配置 env / policy
  Control->>Data: 保存结构化能力状态和 metadata
  Control->>Cap: 请求安装或删除能力
  Cap->>Workspace: staged install / finalize / rollback
  Cap-->>Control: 返回 accepted / result

  Admin->>Control: 触发 Bot 对话
  Control->>BotApi: 转发平台侧 Bot 请求
  BotApi->>Data: 读取 bot 能力状态
  BotApi->>LLM: 发起 runtime 请求
  LLM->>Workspace: 只读加载已安装 skill / MCP
  LLM->>Data: 读取运行时 env
  LLM-->>BotApi: 返回模型输出
  BotApi-->>Control: 返回可见回复
```

## MCP 与记忆链路

```mermaid
flowchart TD
  llm[llm-runner] -->|检测 MCP tool call| mcp[mcp-service]
  mcp --> auth[校验 x-runner-token<br/>bot_id + conversation_id]
  auth --> config[从 data-service 读取 MCP capability config]
  config --> enabled{工具是否启用}

  enabled -->|否| deny[返回 permission_denied]
  enabled -->|是| tool[执行工具]

  tool --> createDoc[创建业务文档<br/>data-service]
  tool --> createMemory[创建 memory metadata<br/>data-service]
  tool --> search[检索 / 写入 / 删除记忆<br/>memory-service]

  search --> vector[(向量存储)]
  createDoc --> data[(data-service.db)]
  createMemory --> data
```

记忆系统分两层：

- `data-service` 保存业务侧 metadata、文档、memory 记录和统计。
- `memory-service` 负责文本切块、embedding、向量搜索、文件/URL/目录摄取等后端能力。

## 启动顺序

```mermaid
flowchart LR
  data[data-service] --> logs[log-service]
  logs --> llm[llm-runner]
  llm --> cap[capability-runner]
  cap --> bot[bot-api]
  bot --> control[control-api]
  control -.真实企微场景.-> worker[wecom-worker]
```

推荐顺序：

1. `data-service`
2. `log-service`
3. `llm-runner`
4. `capability-runner`
5. `bot-api`
6. `control-api`
7. `wecom-worker`，仅在真实企业微信场景启动

基础服务可通过以下命令重建并启动：

```bash
./scripts/dev-redeploy.sh
```

真实企业微信 worker 单独启动：

```bash
docker compose -f deploy/compose/docker-compose.yml --profile wecom up -d wecom-worker
```

## 代码入口速查

- `services/control-api/src/server.ts`：WebUI 和控制面 API。
- `services/bot-host/src/botApiMain.ts`：平台侧 Bot HTTP API 入口。
- `services/bot-host/src/wecomWorkerMain.ts`：企业微信长连接 worker 入口。
- `services/bot-host/src/messageHandler.ts`：共享消息处理、初始化、Prompt 构建、能力命令处理。
- `services/data-service/src/server.ts`：状态中心 API。
- `services/log-service/src/server.ts`：聊天、审计、工具事件日志。
- `services/llm-runner/src/server.ts`：runtime 调用、stream、MCP tool call 续跑。
- `services/capability-runner/src/server.ts`：bot 私有 skill / MCP 安装与删除入口。
- `services/mcp-service/src/server.ts`：可选 MCP 工具服务。
- `services/memory-service/src/main.py`：可选记忆后端服务。
- `packages/contracts/src/`：跨服务共享的请求/响应契约。
