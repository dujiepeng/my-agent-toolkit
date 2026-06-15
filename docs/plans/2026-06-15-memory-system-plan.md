# 记忆系统实现计划

基于 `docs/specs/2026-06-15-memory-system-design.md` 设计文档。

## 阶段划分

### 阶段 1：Memory Service 核心（可独立运行）

**目标：** 部署一个可用的 Memory Service 容器，支持基本的存/取/删。

1. 创建 `services/memory-service/` 项目结构
2. 实现 embedding 模块（bge-m3 加载、文本向量化）
3. 实现存储层（ChromaDB 向量索引 + SQLite 元数据）
4. 实现文本分块器（512 token 窗口，128 重叠）
5. 实现 FastAPI 接口：存入文本、检索、删除、统计
6. 编写 Dockerfile 和 docker-compose.yml
7. 本地测试验证 API 可用

**产出：** 可 `docker compose up` 启动，curl 调用 API 完成存取。

### 阶段 2：文档解析与文件存入

**目标：** 支持多格式文件解析和 URL 抓取。

1. 实现 Markdown/TXT 解析器
2. 实现 PDF 解析器（pymupdf）
3. 实现 Word 解析器（python-docx）
4. 实现 HTML 解析器（beautifulsoup4）
5. 实现文件存入 API（`/ingest` multipart upload）
6. 实现 URL 抓取 API（`/fetch`）
7. 实现目录扫描 API（`/scan`，增量模式）
8. 图片文件存储（原图保存，关联到所属文档）

**产出：** 可上传文件、抓取 URL、扫描目录入库。

### 阶段 3：Bot 侧集成（指令 + 记忆注入）

**目标：** wecom-cli-bot 模板支持记忆相关指令和自动检索注入。

1. `botWorker.ts` 增加记忆指令解析（`/remember`、`/fetch`、`/scan`、`/memory`、`/forget`）
2. `botWorker.ts` 增加 `/help` 指令
3. `botWorker.ts` 增加 `/skill_list`、`/skill_add`、`/skill_remove` 指令
4. 新增 `memoryClient.ts`（HTTP 客户端封装，调用 Memory Service API）
5. `promptBuilder.ts` 增加记忆检索注入逻辑
6. `bot.config.yaml` 增加 memory 配置段
7. `config.ts` 解析 memory 配置
8. 文件消息处理（接收文件 → 调用 Memory ingest API）

**产出：** Bot 可通过指令管理记忆，对话时自动检索相关知识注入 prompt。

### 阶段 4：生命周期与自动摘要

**目标：** 完善自动化能力。

1. Memory Service 增加定时任务（清理 temp、归档 reference）
2. Bot 对话结束后自动提取摘要存入 reference 层
3. 命名空间管理 API（列出、统计）

**产出：** 系统自维护，无需人工清理。

### 阶段 5：Bot Memory Skill 编写

**目标：** 编写轻量 skill 文件，供 Bot CLI 使用。

1. 创建 `.agents/skills/bot-memory/SKILL.md`
2. 编写 `references/api-spec.md`
3. 编写 `references/integration.md`
4. 编写 `references/commands.md`

**产出：** Skill 文件可被 Bot 的 CLI 加载使用。

## 实现顺序建议

```
阶段 1 → 阶段 2 → 阶段 3 → 阶段 4 → 阶段 5
  ↓                   ↓
 部署验证            部署验证
```

阶段 5 可与阶段 3 并行。阶段 1 完成后即可开始集成测试。

## 技术决策

| 决策点 | 选择 | 原因 |
|--------|------|------|
| Embedding 模型 | bge-m3 | 中英双语，768 维，CPU 可跑 |
| 向量库 | ChromaDB | 内嵌式无需额外服务，支持命名空间 |
| 元数据库 | SQLite | 轻量，无需维护 |
| HTTP 框架 | FastAPI | 异步、自带文档、Python 生态 |
| 分块大小 | 512 token / 128 重叠 | 平衡检索精度和上下文完整性 |
| 部署方式 | 独立 Docker 容器 | 解耦，任何 Bot 可对接 |

## 预估工作量

| 阶段 | 预估 |
|------|------|
| 阶段 1 | 核心功能，优先完成 |
| 阶段 2 | 解析器可逐个添加 |
| 阶段 3 | 依赖阶段 1 部署完成 |
| 阶段 4 | 可后续迭代 |
| 阶段 5 | 轻量，随时可写 |
