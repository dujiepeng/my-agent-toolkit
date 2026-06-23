# Bot API 与 WeCom Worker 架构设计

## 背景

当前本地 Compose 中存在 `bot-host` 与 `bot-host-real` 两个容器。它们使用同一套 bot-host 代码，只是环境变量不同：一个偏 HTTP API，一个开启企业微信长连接 worker。这导致两个问题：

- 代码升级时两个容器可能版本不一致。
- 初始化引导状态、待确认文档状态等内存态可能在不同进程里分裂。

项目还未上线，因此不需要兼容旧部署。设计目标是把容器职责拆清楚，并把跨请求、跨容器、跨重启需要保留的状态统一迁到 `data-service`。

## 目标

- `wecom-worker` 不感知 LLM 类型，不关心 Kiro、Claude、Codex、Kimi、OpenAI 或 mock。
- LLM provider 可按 bot 配置自由切换。
- 多 bot 使用独立 workspace 和独立数据空间。
- 容器职责清晰，避免两个容器跑同一套模糊职责。
- 关键状态不放在 `bot-api` 或 `wecom-worker` 内存中。
- 删除 `bot-host-real` 这种命名不清的部署形态。

## 非目标

- 不在本设计中实现完整 Kubernetes 部署。
- 不要求每个 bot 一套平台容器。
- 不要求立即物理拆分 npm package。第一阶段可以同一个 package 多入口启动。
- 不把 LLM provider 逻辑放进 `wecom-worker`。

## 容器与服务

最终 Compose 里的核心容器如下：

```text
control-api
bot-api
wecom-worker
data-service
llm-runner
log-service
```

### control-api

职责：

- 提供 WebUI 和管理 API。
- 管理 bot channel、admin、初始化重置、文档与记忆页面。
- 调用 `bot-api` 执行 bot 相关内部操作。
- 调用 `data-service` 查询持久数据。
- 调用 `log-service` 查询日志。

不负责：

- 不连接企业微信。
- 不调用具体 LLM provider。
- 不保存 bot runtime 状态。

### bot-api

职责：

- 提供 bot 管理类 HTTP 接口。
- 提供 WebUI 模拟消息入口。
- 处理初始化重置、主动通知管理员、触发 worker sync。
- 与 `data-service` 协作读写初始化状态、待确认文档状态、bot 配置。
- 对模拟消息复用与 worker 相同的消息处理核心逻辑。

示例接口：

```text
GET  /health
POST /v1/messages/wecom
POST /internal/bots/:botId/initialization/restart
POST /internal/wecom-runtime/sync
```

不负责：

- 不持有企业微信长连接。
- 不把 wizard state 或 pending document state 放内存。
- 不拼接具体 CLI 命令。

### wecom-worker

职责：

- 连接企业微信长连接。
- 从 `data-service` 拉取启用的 bot channel。
- 为每个启用 bot 管理独立 worker runtime。
- 收到企微消息后交给统一 message handler。
- 将 handler 结果发送回企业微信。
- channel 删除、禁用、重置时停止对应 bot worker。

不负责：

- 不提供 WebUI。
- 不直接访问具体 LLM CLI。
- 不知道 bot 使用哪个 LLM provider。
- 不持久保存初始化状态或待确认文档。

### data-service

职责：

- 唯一状态中心。
- 保存 bot、channel、admin、conversation、workspace、config document、business document、memory、runtime config。
- 保存初始化向导状态。
- 保存待确认生成文档。
- 保存 bot runtime provider 配置。

关键原则：

```text
bot-api 和 wecom-worker 不共享内存，只共享 data-service。
```

### llm-runner

职责：

- 统一 LLM/CLI 调用入口。
- 封装 provider 差异。
- 管理 provider runtime session。
- 支持同步与流式调用。

Provider 示例：

```text
mock
kiro
claude
codex
kimi
openai
```

`wecom-worker` 和 `bot-api` 不应依赖 provider 细节，只调用统一接口：

```text
POST /v1/chat
POST /v1/chat/stream
```

### log-service

职责：

- 保存 chat event。
- 保存 worker event。
- 保存 error event。
- 支持后续分析。

## 服务调用关系

```text
control-api -> bot-api
control-api -> data-service
control-api -> log-service

bot-api -> data-service
bot-api -> llm-runner
bot-api -> log-service

wecom-worker -> data-service
wecom-worker -> llm-runner
wecom-worker -> log-service
wecom-worker -> 企业微信

llm-runner -> provider adapter
```

真实企业微信消息流：

```text
企业微信
  -> wecom-worker
  -> message handler
  -> data-service 读取 bot 状态、soul、agents、memory、runtime config
  -> llm-runner
  -> provider adapter
  -> llm-runner
  -> message handler
  -> wecom-worker
  -> 企业微信
```

WebUI 模拟消息流：

```text
WebUI
  -> control-api
  -> bot-api
  -> message handler
  -> data-service
  -> llm-runner
  -> bot-api
  -> control-api
  -> WebUI
```

## Bot 隔离模型

多个 bot 不对应多套平台容器。隔离单位是 `bot_id`。

文件空间：

```text
/data/bots/{bot_id}/
  workspace/
  runtime/
  temp/
```

数据空间：

```text
bot_config_documents.bot_id = bot_id
business_documents.scope = bot
business_documents.owner_id = bot_id
memory_documents.scope = bot
memory_documents.owner_id = bot_id
conversations.bot_id = bot_id
initialization_sessions.bot_id = bot_id
pending_generated_documents.bot_id = bot_id
runtime_configs.bot_id = bot_id
```

卸载 bot 时按 `bot_id` 清理：

```text
1. 禁用或删除 bot channel
2. wecom-worker 停止该 bot 长连接
3. 删除 bot config
4. 删除 bot workspace
5. 删除 bot documents
6. 删除 bot memories
7. 删除 bot sessions
8. 删除 pending state
9. 日志保留或归档
```

## 状态归属

当前需要迁出 bot-host 内存的状态：

```text
wizardStatesByConfig
pendingBusinessDocumentsByConfig
```

目标状态表或存储对象：

```text
initialization_sessions
pending_generated_documents
runtime_configs
workspace_records
```

### initialization_sessions

保存初始化引导进度。

字段建议：

```text
session_id
bot_id
wecom_user_id
conversation_id
phase: soul | agents
soul_answers: json
agents_answers: json
generation_in_progress: null | soul | agents
status: active | completed | cancelled
created_at
updated_at
```

### pending_generated_documents

保存已经生成、等待用户确认的 Markdown 文档。

字段建议：

```text
pending_id
bot_id
wecom_user_id
conversation_id
title
content
status: pending | confirmed | cancelled
created_by_bot_id
created_by_user_id
created_at
updated_at
```

确认后写入现有 business document 版本体系：

```text
不存在同名文档 -> createBusinessDocument -> v1
存在同名文档 -> updateBusinessDocument -> vN+1
```

### runtime_configs

保存 bot 使用的 LLM provider。

示例：

```json
{
  "bot_id": "prd-bot",
  "provider": "kiro",
  "stream": true,
  "options": {
    "timeout_ms": 120000
  }
}
```

## LLM 可切换设计

`wecom-worker` 不读取 provider 细节。它只把消息交给 message handler。

message handler 从 `data-service` 读取当前 bot runtime config，然后调用 `llm-runner`：

```json
{
  "bot_id": "prd-bot",
  "user_id": "wecom-user-a",
  "conversation_id": "conv_xxx",
  "runtime": {
    "provider": "kiro",
    "stream": true,
    "options": {
      "timeout_ms": 120000
    }
  },
  "messages": [
    {
      "role": "system",
      "content": "soul + agents + memory"
    },
    {
      "role": "user",
      "content": "我需要一个语音转文字 API"
    }
  ]
}
```

`llm-runner` 内部选择 adapter：

```text
provider = kiro   -> kiro adapter
provider = mock   -> mock adapter
provider = openai -> openai adapter
```

Provider session 映射：

```text
data-service:
  bot_id + user_id + conversation_id -> runtime_session_key

llm-runner:
  runtime_session_key + provider -> provider session
```

## 启动入口

第一阶段可以继续使用 `services/bot-host` package，但拆成两个入口：

```text
services/bot-host/src/botApiMain.ts
services/bot-host/src/wecomWorkerMain.ts
```

Compose：

```yaml
bot-api:
  build:
    context: ../..
    dockerfile: services/bot-host/Dockerfile
  command: ["node", "services/bot-host/dist/botApiMain.js"]
  environment:
    PORT: "8400"
    DATA_SERVICE_URL: "http://data-service:8300"
    LLM_RUNNER_URL: "http://llm-runner:8200"
    LOG_SERVICE_URL: "http://log-service:8500"

wecom-worker:
  build:
    context: ../..
    dockerfile: services/bot-host/Dockerfile
  command: ["node", "services/bot-host/dist/wecomWorkerMain.js"]
  environment:
    PORT: "8401"
    DATA_SERVICE_URL: "http://data-service:8300"
    LLM_RUNNER_URL: "http://llm-runner:8200"
    LOG_SERVICE_URL: "http://log-service:8500"
    WECOM_RUNTIME_SYNC_INTERVAL_MS: "5000"
```

第二阶段如果代码继续变大，再物理拆分目录：

```text
services/bot-api
services/wecom-worker
packages/bot-runtime
```

其中 `packages/bot-runtime` 保存共享 message handler，避免 API 和 worker 行为分叉。

## 迁移计划

1. 新增 data-service 状态能力
   - `initialization_sessions`
   - `pending_generated_documents`
   - `runtime_configs`

2. 抽取共享 message handler
   - 从 bot-host 中抽出消息处理核心逻辑。
   - bot-api 和 wecom-worker 都调用它。

3. 拆启动入口
   - 新增 `botApiMain.ts`。
   - 新增 `wecomWorkerMain.ts`。
   - 保留旧 main 直到 compose 切换完成。

4. 更新 compose
   - 删除 `bot-host-real`。
   - `bot-host` 改名为 `bot-api`。
   - 新增 `wecom-worker`。
   - `control-api` 的 `BOT_HOST_URL` 改为 `http://bot-api:8400`。

5. 迁移测试
   - bot-api 模拟消息测试。
   - wecom-worker 真实长连接 worker 测试。
   - 初始化引导状态跨进程测试。
   - 待确认文档跨进程确认测试。
   - provider 切换测试。

6. 更新文档
   - compose README。
   - 服务职责说明。
   - bot 卸载流程。

## 验收标准

- Compose 中不存在 `bot-host-real`。
- `control-api` 只依赖 `bot-api`。
- `wecom-worker` 只处理企微长连接，不提供 WebUI 管理入口。
- 初始化引导中途重启 `wecom-worker` 后仍可继续。
- 生成 Markdown 文档后，换进程确认仍能保存到长期文档存储。
- 修改 bot runtime provider 不需要改 `wecom-worker` 代码。
- 多个 bot 可以共用一组平台容器，但数据按 `bot_id` 隔离。
- 删除 bot 能停止对应 worker 并清理该 bot 的 workspace 与数据。

