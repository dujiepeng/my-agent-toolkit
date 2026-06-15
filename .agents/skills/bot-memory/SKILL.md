---
name: bot-memory
description: "当 Bot 配置了 memory 功能时使用。提供长期知识库能力：存入、检索、管理记忆。在对话中自动检索相关历史知识注入 prompt 上下文。"
---

# Bot Memory Skill

## 触发条件

当 `bot.config.yaml` 中 `memory.enabled: true` 且环境变量 `MEMORY_API_URL` 已设置时激活。

## 功能

- 对话时自动检索 Memory Service 中相关知识，注入 prompt 作为上下文参考
- 用户可通过指令手动管理记忆（存入、删除、统计）
- 支持文本、文件、URL 多种来源存入
- 按命名空间隔离，支持 shared 跨 Bot 共享

## 用户指令

| 指令 | 功能 |
|------|------|
| `/remember <文本>` | 存入当前 Bot 的记忆（core 层） |
| `/remember --shared <文本>` | 存入共享记忆 |
| `/remember #tag1 #tag2 <文本>` | 带标签存入 |
| `/fetch <url>` | 抓取 URL 内容解析后存入 |
| `/scan [目录]` | 扫描指定目录（默认 workspace/files）增量索引 |
| `/memory` | 查看记忆条数和统计 |
| `/forget <关键词>` | 按关键词删除匹配的记忆 |

## 配置

`bot.config.yaml` 中添加：

```yaml
memory:
  enabled: true
  api_url_env: MEMORY_API_URL
  namespace_env: MEMORY_NAMESPACE
  auto_retrieve: true
  auto_store: true
  retrieve_limit: 5
```

环境变量：
- `MEMORY_API_URL` — Memory Service 地址（如 `http://memory-service:8000`）
- `MEMORY_NAMESPACE` — 当前 Bot 的命名空间（如 `product`、`qa`）

## 实现参考

Memory Service 代码位于 `services/memory-service/`，API 文档见 `references/api-spec.md`。
