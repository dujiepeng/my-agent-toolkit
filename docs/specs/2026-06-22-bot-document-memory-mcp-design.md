# Bot 文档与记忆 MCP 设计

## 目标

新增一个独立的 `mcp-service`，把 Bot 的文档、记忆、搜索和共享知识能力封装成 MCP 工具，供 `kiro-cli` 以及后续其他 CLI runtime 使用。

这个 MCP 的核心目标不是给 LLM 更多无边界权限，而是给 LLM 一组可审计、可限权、可复用的工作工具。

## 非目标

- 不通过 MCP 管理 Bot 控制面配置。
- 不允许普通 Bot 通过 MCP 修改 `soul.md`、`agents.md`、管理员、Channel、企业微信 Secret 或 runtime session。
- 第一版不实现复杂 Web 管理后台、人工审批流、MCP marketplace、跨 Bot 协同 UI。
- 第一版不强制接入向量数据库；可以先用当前 `data-service` 和简单搜索能力落地。

## 边界

### 平台配置面

以下内容继续由 `control-api`、WebUI、初始化流程和 `data-service` 管理：

- Bot 创建、删除、状态。
- 企业微信 Bot ID / Secret。
- 管理员认领、转移、重置。
- 初始化流程状态。
- `soul.md`。
- `agents.md`。
- runtime session。
- Channel 状态。

`soul.md` 和 `agents.md` 是 Bot 配置，不是 Bot 生成的普通文档：

- `soul.md`：机器人是谁，包括身份、性格、沟通风格、价值观和人格边界。
- `agents.md`：机器人如何工作，包括能力范围、行为规则、任务流程、工具与文档规范。

### Bot 工作能力面

以下能力通过 MCP 暴露给 Bot：

- 创建业务文档。
- 更新业务文档。
- 查询业务文档。
- 搜索业务文档。
- 写入长期记忆。
- 检索长期记忆。
- 读取当前上下文。
- 记录工具调用审计事件。

## 推荐架构

```text
企业微信
  -> bot-host
  -> llm-runner
  -> kiro-cli / other CLI
  -> MCP tools
  -> mcp-service
  -> data-service / search backend / log-service
```

`mcp-service` 不替代 `data-service`。它是 LLM 工具层，负责权限、参数校验、脱敏、审计和 MCP 协议适配；`data-service` 继续作为事实来源。

## 服务职责

### mcp-service

负责：

- 暴露 MCP tools。
- 校验 tool input。
- 校验上下文权限。
- 调用 `data-service` 完成文档和记忆读写。
- 调用搜索后端完成检索。
- 调用 `log-service` 记录 tool events。
- 对错误做结构化归一。

不负责：

- 保存企业微信 Secret。
- 管理 Bot 初始化。
- 修改 `soul.md` 或 `agents.md`。
- 启停 Bot workload。
- 直接执行任意 shell 命令。

### llm-runner

负责：

- 启动 CLI runtime。
- 给 CLI 注入 MCP 配置。
- 传递可信上下文，如 `bot_id`、`user_id`、`conversation_id`。
- 维护 runtime session。

`llm-runner` 不应让模型自己声明身份上下文。

### data-service

负责：

- 保存业务文档。
- 保存文档版本。
- 保存记忆记录。
- 保存 scope、owner、visibility、metadata。
- 提供受控 API 给 `mcp-service`。

### log-service

负责：

- 保存 MCP tool call 事件。
- 保存耗时、状态、错误类型、目标资源 ID。
- 避免保存 Secret、认证码、完整敏感内容。

## Scope 模型

所有文档和记忆都必须有 scope：

```text
system
shared
bot
user
session
```

含义：

- `system`：平台级知识，默认只读。
- `shared`：多 Bot 共享知识，可用于协作。
- `bot`：当前 Bot 私有工作知识。
- `user`：某个企微用户的偏好、身份和长期上下文。
- `session`：当前会话临时上下文和阶段总结。

第一版写权限：

| scope | 读权限 | 写权限 |
| --- | --- | --- |
| system | 所有授权 Bot | 仅平台管理员 |
| shared | 授权 Bot | 管理员或授权 Bot |
| bot | 当前 Bot | 当前 Bot |
| user | 当前用户相关 Bot | 用户确认后写 |
| session | 当前会话 | 当前会话 |

## 可信上下文

MCP 请求必须绑定可信上下文：

```json
{
  "bot_id": "testbot-okurjh",
  "user_id": "woYddk...",
  "conversation_id": "conv_xxx",
  "runtime": "kiro"
}
```

这些字段不能来自模型自然语言输出，也不能让 LLM 通过 tool input 自己伪造。

第一版建议由 `llm-runner` 为每次 CLI 运行生成带上下文的 MCP endpoint：

```text
http://mcp-service:8700/mcp/bots/{bot_id}/sessions/{conversation_id}
```

同时注入内部 header：

```text
x-runner-token: signed-token
```

`mcp-service` 通过 token 校验请求来自可信 `llm-runner`。

## MCP 工具

### document.create

创建业务文档，例如 PRD、竞品分析、评审纪要、接口设计。

输入：

```json
{
  "scope": "bot",
  "owner_id": "testbot-okurjh",
  "title": "语音转文字 API PRD",
  "doc_type": "prd",
  "content": "...",
  "tags": ["prd", "asr", "api"],
  "visibility": "bot"
}
```

输出：

```json
{
  "document_id": "doc_xxx",
  "title": "语音转文字 API PRD",
  "version": 1,
  "created_at": "2026-06-22T00:00:00.000Z"
}
```

规则：

- 不允许创建标题为 `soul`、`soul.md`、`agents`、`agents.md`、`AGENTS.md` 的文档。
- `content` 必须是 Bot 产出的业务内容，不是平台配置。
- 创建成功后记录 `tool_event`。

### document.update

更新已有业务文档，并创建新版本。

输入：

```json
{
  "document_id": "doc_xxx",
  "content": "...",
  "change_summary": "补充计量计费和 Console 影响"
}
```

输出：

```json
{
  "document_id": "doc_xxx",
  "version": 2,
  "updated_at": "2026-06-22T00:00:00.000Z"
}
```

规则：

- 必须校验当前 Bot 是否有权限更新目标文档。
- 更新业务文档可以版本化。
- 不支持更新 `soul.md` 或 `agents.md`。

### document.get

读取业务文档。

输入：

```json
{
  "document_id": "doc_xxx",
  "version": "latest"
}
```

输出：

```json
{
  "document_id": "doc_xxx",
  "title": "语音转文字 API PRD",
  "doc_type": "prd",
  "version": 2,
  "content": "...",
  "scope": "bot",
  "owner_id": "testbot-okurjh"
}
```

### document.list

列出业务文档。

输入：

```json
{
  "scope": "bot",
  "owner_id": "testbot-okurjh",
  "doc_type": "prd",
  "limit": 20
}
```

输出：

```json
{
  "documents": [
    {
      "document_id": "doc_xxx",
      "title": "语音转文字 API PRD",
      "doc_type": "prd",
      "version": 2,
      "updated_at": "2026-06-22T00:00:00.000Z"
    }
  ]
}
```

### document.search

搜索业务文档。

输入：

```json
{
  "query": "语音转文字 计量计费 console",
  "scopes": ["shared", "bot"],
  "owner_ids": ["platform", "testbot-okurjh"],
  "limit": 10
}
```

输出：

```json
{
  "results": [
    {
      "document_id": "doc_xxx",
      "title": "语音转文字 API PRD",
      "snippet": "...",
      "score": 0.82
    }
  ]
}
```

第一版搜索可以用数据库文本搜索；后续再接向量数据库。

### memory.write

写入长期记忆。

输入：

```json
{
  "scope": "user",
  "owner_id": "woYddk...",
  "content": "用户叫杜洁鹏，关注环信 IM 产品和 PRD 质量。",
  "source": {
    "conversation_id": "conv_xxx",
    "message_id": "msg_xxx"
  },
  "tags": ["user-profile"]
}
```

输出：

```json
{
  "memory_id": "mem_xxx",
  "created_at": "2026-06-22T00:00:00.000Z"
}
```

规则：

- 用户级长期记忆必须来自用户明确确认，或来自管理员配置。
- 临时推测不能写入长期记忆。
- 不允许写入 Secret、API Key、管理员认领码、认证文件路径。

### memory.search

检索长期记忆。

输入：

```json
{
  "query": "用户身份和偏好",
  "scopes": ["user", "bot", "shared"],
  "owner_ids": ["woYddk...", "testbot-okurjh", "platform"],
  "limit": 5
}
```

输出：

```json
{
  "results": [
    {
      "memory_id": "mem_xxx",
      "content": "用户叫杜洁鹏...",
      "scope": "user",
      "owner_id": "woYddk...",
      "score": 0.91
    }
  ]
}
```

### context.get

读取当前可用上下文摘要。

输入：

```json
{
  "include": ["session", "user", "bot", "shared"],
  "limit": 20
}
```

输出：

```json
{
  "session_summary": "...",
  "memories": [],
  "documents": [],
  "shared_context": []
}
```

规则：

- 不返回 `soul.md` 和 `agents.md`，它们由 `llm-runner` 直接注入 prompt。
- 只返回当前可信上下文允许访问的数据。

## 数据模型

### documents

```text
document_id
scope
owner_id
title
doc_type
visibility
created_by_bot_id
created_by_user_id
created_at
updated_at
```

### document_versions

```text
document_id
version
content
change_summary
created_at
```

### document_tags

```text
document_id
tag
```

### memories

```text
memory_id
scope
owner_id
content
source_conversation_id
source_message_id
created_by_bot_id
created_by_user_id
created_at
updated_at
```

### memory_tags

```text
memory_id
tag
```

### tool_events

可在 `log-service` 中维护：

```text
event_id
bot_id
user_id
conversation_id
tool_name
input_summary
output_summary
target_type
target_id
status
error_code
duration_ms
created_at
```

## 错误模型

MCP 工具错误使用结构化错误码：

```text
permission_denied
not_found
validation_error
storage_unavailable
search_unavailable
rate_limited
unsafe_content
```

错误不直接暴露底层堆栈。Bot 可以据此回复用户：

```text
文档保存失败，我可以先把内容发给你，稍后再保存。
```

## Kiro CLI 集成

`llm-runner` 为每次运行生成 MCP 配置。

如果 Kiro 支持 HTTP MCP：

```json
{
  "mcpServers": {
    "bot-workspace": {
      "url": "http://mcp-service:8700/mcp/bots/testbot-okurjh/sessions/conv_xxx",
      "headers": {
        "x-runner-token": "signed-token"
      }
    }
  }
}
```

如果 Kiro 只支持 stdio MCP：

```text
kiro-cli
  -> stdio mcp adapter
  -> http mcp-service
```

第一版优先选择当前 Kiro CLI 实际支持的方式。如果二者都可行，优先 HTTP MCP，减少本地 adapter 复杂度。

## agents.md 工具规则

初始化生成的 `agents.md` 应包含 MCP 使用规则：

- 需要保存业务文档时使用 `document.create` 或 `document.update`。
- 需要查询已有文档时使用 `document.get`、`document.list` 或 `document.search`。
- 只有确认过的长期事实才写入 `memory.write`。
- 不要通过文档工具写入 `soul.md` 或 `agents.md`。
- 工具失败时先向用户说明，不伪造保存成功。

## WebUI 影响

WebUI 需要继续区分：

- 机器人配置：`soul.md`、`agents.md`。
- Bot 生成文档：来自 `document.*` MCP 工具。
- 记忆：来自 `memory.*` MCP 工具。
- 工具调用日志：来自 `tool_events`。

文档列表不展示 `soul.md` 和 `agents.md`。

## 第一版范围

第一版实现：

- 新增 `services/mcp-service`。
- MCP tools：
  - `document.create`
  - `document.update`
  - `document.get`
  - `document.list`
  - `document.search`
  - `memory.write`
  - `memory.search`
  - `context.get`
- `data-service` 增加业务文档和记忆 API。
- `log-service` 增加 `tool_events`。
- `llm-runner` 为 Kiro 注入 MCP。
- WebUI 展示业务文档列表和工具事件摘要。

第一版不实现：

- 向量数据库。
- 文档 diff 页面。
- 复杂权限 UI。
- 人工审批流。
- MCP marketplace。

## 验收标准

- Bot 不能通过 MCP 创建或更新 `soul.md`、`agents.md`。
- Bot 可以通过 MCP 创建一份 PRD 文档。
- WebUI 可以看到该 PRD 文档，但不会把它和机器人配置混在一起。
- Bot 可以通过 MCP 写入一条确认过的 user memory。
- 后续对话可以通过 `memory.search` 找回该 memory。
- `log-service` 能看到工具调用事件。
- Kiro runtime 可以真实调用 MCP 工具，而不是 mock。
- 权限越界时返回 `permission_denied`。

