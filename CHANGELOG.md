# 更新日志

## 2026-06-15

### memory-service（新增）

- 新增 Memory Service 独立服务
- FastAPI + ChromaDB + SQLite 存储层
- fastembed（bge-small-zh-v1.5）本地 embedding，无需 GPU
- 文本存入、语义检索、删除、统计 API
- 文件上传解析（Markdown/TXT/PDF/Word/HTML）
- URL 抓取存入
- 目录扫描增量索引
- 知识分层：core（永久）/ reference（90天归档）/ temp（7天清理）
- 命名空间隔离 + shared 共享检索
- 生命周期定时任务（每日自动清理/归档）
- Docker 部署，镜像约 1GB

### bot-memory（新增技能）

- 新增 Bot 记忆技能（轻量 markdown）
- SKILL.md 描述触发条件和配置方式
- references/api-spec.md 完整 API 文档
- references/commands.md 用户指令说明

### wecom-cli-bot

- 新增完整指令体系：`/help` `/stop` `/history` `/new` `/open N` `/name`
- 新增记忆指令：`/remember` `/fetch` `/scan` `/memory` `/forget`
- 新增技能管理指令：`/skill_list` `/skill_add` `/skill_remove`
- 新增 memoryClient.ts（Memory Service HTTP 客户端）
- promptBuilder.ts 改为异步，支持记忆检索自动注入 prompt
- types.ts 新增 MemoryConfig 类型
- thinking_message 精简为 `/stop 终止 /help 帮助`

## 2026-06-12

### wecom-cli-bot

- 新增 Kiro CLI Provider 完整支持（安装、session resume、输出解析）
- 新增用户会话隔离（per-user cwd）
- 新增历史会话管理（列表、恢复、命名、首条消息记录）
- 新增 ANSI 转义码和框架噪音自动清理
- 更新 Dockerfile：添加 `/root/.local/bin` 到 PATH，支持 python3、unzip
- 更新 redact.ts：ANSI strip + kiro-cli 框架输出过滤
- 更新 cli-adapters.md 和 runtime-installation.md 参考文档
