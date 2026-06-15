# 记忆系统设计文档

## 1. 目标

为企业微信 CLI 机器人提供持久化知识库能力。Bot 能积累领域知识、跨会话检索历史信息，在生成新内容时自动参考相关记忆。

## 2. 设计原则

- **独立部署** — Memory Service 是独立容器，任何 Bot 通过 HTTP API 对接，不绑定部署形态
- **轻量 skill** — skill 只描述调用规范，不含服务实现代码
- **按需检索** — 不是所有对话都需要记忆，Bot 自行判断是否检索
- **多来源输入** — 支持文本、文件、URL、自动摘要等多种存入方式
- **分层管理** — 核心知识永久保留，临时信息自动清理

## 3. 整体架构

```
┌─────────────────────────────────────────────────┐
│  企业微信用户                                      │
│  (文本 / 文件 / URL / 指令)                        │
└──────────────────────┬──────────────────────────┘
                       ↓
┌──────────────────────────────────────────────────┐
│  wecom-cli-bot 实例 (可多个，可同容器或独立容器)      │
│                                                    │
│  ┌─────────────┐  ┌──────────────┐               │
│  │ botWorker   │  │ promptBuilder│               │
│  │ (指令解析)   │  │ (记忆注入)    │               │
│  └──────┬──────┘  └──────┬───────┘               │
│         │                 │                        │
│         └────────┬────────┘                        │
│                  ↓                                  │
│         Memory Client (HTTP)                        │
└──────────────────┬─────────────────────────────────┘
                   ↓
┌──────────────────────────────────────────────────┐
│  Memory Service (独立 Docker 容器)                  │
│                                                    │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐  │
│  │ FastAPI  │  │ Embedding │  │ 文档解析器    │  │
│  │ 接口层    │  │ (bge-m3)  │  │ (md/pdf/docx)│  │
│  └────┬─────┘  └─────┬─────┘  └──────┬───────┘  │
│       │               │               │           │
│       └───────────────┼───────────────┘           │
│                       ↓                            │
│  ┌─────────────────────────────────────────────┐ │
│  │ 存储层                                        │ │
│  │ ┌───────────┐ ┌──────────┐ ┌─────────────┐ │ │
│  │ │ ChromaDB  │ │ SQLite   │ │ 文件系统     │ │ │
│  │ │ (向量索引) │ │ (元数据)  │ │ (原始文件)   │ │ │
│  │ └───────────┘ └──────────┘ └─────────────┘ │ │
│  └─────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

## 4. Memory Service

### 4.1 技术栈

| 组件 | 选型 | 说明 |
|------|------|------|
| 框架 | FastAPI | 轻量异步 HTTP |
| Embedding | bge-m3 (BAAI) | 中英双语，CPU 可运行 |
| 向量库 | ChromaDB | 内嵌式，无需额外依赖 |
| 元数据 | SQLite | 标签、层级、时间等结构化信息 |
| 文件存储 | 本地磁盘 | 原始文件和图片 |

### 4.2 API 设计

#### 存入文本

```
POST /api/v1/memories
{
  "namespace": "product",
  "content": "文本内容",
  "tags": ["PRD", "IM"],
  "tier": "core",
  "source": "text",
  "metadata": {
    "user_id": "xxx",
    "title": "可选标题"
  }
}
→ 200 { "id": "mem_xxx", "chunks": 3 }
```

#### 存入文件

```
POST /api/v1/memories/ingest
Content-Type: multipart/form-data

file: <binary>
namespace: product
tags: PRD,IM
tier: core
→ 200 { "id": "mem_xxx", "chunks": 12, "filename": "xxx.md" }
```

#### 存入 URL

```
POST /api/v1/memories/fetch
{
  "namespace": "product",
  "url": "https://...",
  "tags": ["PRD"],
  "tier": "core"
}
→ 200 { "id": "mem_xxx", "chunks": 8 }
```

#### 检索

```
POST /api/v1/memories/search
{
  "namespace": "product",
  "query": "用户注册流程",
  "tags": ["PRD"],           // 可选，标签粗筛
  "limit": 5,
  "include_shared": true
}
→ 200 {
  "results": [
    {
      "id": "mem_xxx",
      "chunk_id": "chk_xxx",
      "content": "相关文本片段...",
      "score": 0.87,
      "tags": ["PRD", "注册"],
      "tier": "core",
      "metadata": {
        "filename": "注册模块PRD.md",
        "title": "注册模块",
        "created_at": "2026-06-10T10:00:00Z"
      },
      "assets": ["/data/assets/mem_xxx/flow.png"]
    }
  ]
}
```

#### 删除

```
DELETE /api/v1/memories/{id}
DELETE /api/v1/memories?namespace=product&tags=旧版本
```

#### 统计

```
GET /api/v1/memories/stats?namespace=product
→ 200 {
  "total_memories": 42,
  "total_chunks": 358,
  "by_tier": { "core": 30, "reference": 10, "temp": 2 },
  "disk_usage_mb": 125
}
```

#### 扫描目录

```
POST /api/v1/memories/scan
{
  "namespace": "product",
  "directory": "/path/to/docs",
  "tags": ["PRD"],
  "tier": "core",
  "incremental": true       // 仅处理新增/修改文件
}
```

### 4.3 命名空间

| 命名空间 | 用途 | 访问规则 |
|----------|------|----------|
| `product` | 产品 Bot 知识 | 产品 Bot 读写 |
| `qa` | QA Bot 知识 | QA Bot 读写 |
| `jira` | Jira Bot 知识 | Jira Bot 读写 |
| `shared` | 公共知识 | 所有 Bot 可读，任何 Bot 可写 |
| 自定义 | 未来新 Bot | 通过环境变量配置 |

检索时默认行为：`搜索自身 namespace + shared`

### 4.4 知识分层

| 层级 | 内容示例 | 生命周期 | 存入方式 |
|------|----------|----------|----------|
| core | PRD、设计文档、决策记录 | 永久 | 手动 /remember、文件上传、/scan |
| reference | 对话摘要、会议纪要 | 90 天未访问归档 | 自动提取、/remember |
| temp | 单次对话上下文 | 7 天自动清理 | 自动 |

### 4.5 文档解析

| 格式 | 库 | 说明 |
|------|-----|------|
| Markdown / TXT | 内置 | 按标题/段落分块 |
| PDF | pymupdf | 提取文本和图片 |
| Word (.docx) | python-docx | 提取段落和表格 |
| Excel (.xlsx) | openpyxl | 按 sheet 提取 |
| HTML | beautifulsoup4 | 提取正文 |
| 图片 | — | 仅存原图，关联到所属文档上下文 |

### 4.6 分块策略

- 窗口大小：512 token
- 重叠：128 token
- 尊重段落/标题边界，不在句子中间切断
- 每块携带：所属文档 ID、块序号、原始位置

### 4.7 生命周期管理

定时任务（每日凌晨执行）：
- 清理 tier=temp 且创建超过 7 天的记忆
- 归档 tier=reference 且 90 天未被检索命中的记忆（标记为 archived，不参与检索，不删除数据）
- 清理无关联的 assets 文件

## 5. Bot 指令体系

### 5.1 完整指令表

| 分类 | 指令 | 功能 |
|------|------|------|
| 帮助 | `/help` | 显示所有可用指令 |
| 会话 | `/stop` | 终止当前任务 |
| | `/new` | 开始新会话 |
| | `/history` | 历史会话列表 |
| | `/open N` | 恢复第 N 个历史会话 |
| | `/name <名称>` | 命名当前会话 |
| 记忆 | `/remember <文本>` | 存入 core 层记忆 |
| | `/remember --shared <文本>` | 存入 shared 命名空间 |
| | `/remember #tag1 #tag2 <文本>` | 带标签存入 |
| | `/fetch <url>` | 抓取 URL 内容存入 |
| | `/scan [目录]` | 扫描 workspace 文件增量索引 |
| | `/memory` | 查看记忆统计 |
| | `/forget <关键词>` | 删除匹配的记忆 |
| | 发送文件 | 自动解析存入 core 层 |
| 技能 | `/skill_list` | 列出已安装的 Bot skill |
| | `/skill_add <git_url>` | 从 git 仓库安装 skill 到 `workspace/files/.agents/skills/` |
| | `/skill_remove <name>` | 卸载指定 skill |

### 5.2 /help 输出格式

```
可用指令：

会话管理
  /stop        终止当前任务
  /new         开始新会话
  /history     历史会话列表
  /open N      恢复第 N 个会话
  /name <名称>  命名当前会话

记忆管理
  /remember <文本>   存入记忆
  /fetch <url>      抓取 URL 存入
  /scan [目录]       扫描文件存入
  /memory           记忆统计
  /forget <关键词>   删除记忆

技能管理
  /skill_list              已装技能列表
  /skill_add <git_url>    安装技能
  /skill_remove <name>    卸载技能
```

### 5.3 Skill 管理

Bot 的 skill 目录：`workspace/files/.agents/skills/`

**`/skill_list`：**
- 扫描 `workspace/files/.agents/skills/` 下的子目录
- 每个子目录读取 `SKILL.md` 的 name 和 description
- 格式化返回列表

**`/skill_add <git_url>`：**
- `git clone <url>` 到 `workspace/files/.agents/skills/<repo-name>/`
- 如果已存在则 `git pull` 更新
- 返回安装成功信息和 skill 描述

**`/skill_remove <name>`：**
- 删除 `workspace/files/.agents/skills/<name>/` 目录
- 返回确认

## 6. Bot Memory Skill

### 6.1 定位

轻量 skill（仅 markdown），指导 Bot 如何与 Memory Service 交互。

### 6.2 自动行为

**检索注入（每次对话）：**
1. 用户消息到达
2. 提取消息关键词
3. 调用 Memory API search
4. 取 top 5 结果注入 prompt

**自动存入（对话结束后）：**
1. Bot 判断本次对话是否产生了新知识/决策
2. 如果是，提取摘要存入 reference 层

### 6.3 Prompt 结构

```
# Soul
(Bot 角色定义)

# 相关记忆
以下是与当前问题相关的历史知识，供参考：

1. [PRD] 注册模块PRD.md (2026-06-10)
   用户注册流程分为手机号注册和第三方登录两种方式...

2. [决策] 关于注册验证码方案 (2026-06-08)
   决定采用短信验证码+图形验证码双重验证...

# 操作指令
...

# 用户消息
(用户的问题)
```

### 6.4 Bot 配置

Bot 的 `bot.config.yaml` 中增加 memory 配置：

```yaml
memory:
  enabled: true
  api_url_env: MEMORY_API_URL
  namespace_env: MEMORY_NAMESPACE
  auto_retrieve: true
  auto_store: true
  retrieve_limit: 5
```

## 7. Bot 创建引导流程

使用 `wecom-cli-bot` skill 创建新 Bot 时，引导以下配置步骤：

1. **基本信息** — Bot 名称、角色描述（soul）
2. **CLI Provider** — 选择 Kimi Code / Kiro CLI / Codex / Claude Code
3. **WeCom 凭证** — Bot ID 和 Secret
4. **命名空间** — 为 Bot 分配 memory 命名空间（新建 or 复用已有）
5. **Memory 配置** — 是否启用记忆、自动检索、自动存入
6. **初始 Skill** — 是否需要预装 skill（提供 git URL 列表）
7. **环境变量** — 其他业务相关的环境变量（如 Jira 凭证）
8. **部署** — 生成 docker-compose 配置并构建

## 8. 部署

### Memory Service 容器

```yaml
# services/memory-service/docker-compose.yml
services:
  memory-service:
    build: .
    ports:
      - "8100:8000"
    volumes:
      - ./data:/app/data    # 持久化存储
    environment:
      - EMBEDDING_MODEL=BAAI/bge-m3
      - DEVICE=cpu          # 或 mps (Apple Silicon)
    restart: unless-stopped
```

### Bot 侧配置

```yaml
# Bot 的 docker-compose.yml 中
environment:
  - MEMORY_API_URL=http://host.docker.internal:8100
  - MEMORY_NAMESPACE=product
```

网络连接方式：
- 同一 docker-compose：使用 service name `http://memory-service:8000`
- 同一宿主机不同 compose：使用 `http://host.docker.internal:8100`
- 不同机器：使用 `http://<ip>:8100`

## 9. 项目文件结构

```
my-agent-toolkit/
├── .agents/skills/
│   └── bot-memory/
│       ├── SKILL.md              # 触发条件
│       └── references/
│           ├── api-spec.md       # API 接口文档
│           ├── integration.md    # Bot 集成指南
│           └── commands.md       # 用户指令说明
├── services/
│   └── memory-service/
│       ├── Dockerfile
│       ├── docker-compose.yml
│       ├── requirements.txt
│       └── src/
│           ├── main.py           # FastAPI 入口
│           ├── api/
│           │   ├── memories.py   # CRUD 路由
│           │   └── search.py     # 检索路由
│           ├── core/
│           │   ├── embedding.py  # bge-m3 加载和推理
│           │   ├── chunker.py    # 文本分块
│           │   └── lifecycle.py  # 生命周期管理（清理/归档）
│           ├── parsers/
│           │   ├── markdown.py
│           │   ├── pdf.py
│           │   ├── docx.py
│           │   └── html.py
│           └── storage/
│               ├── vector.py     # ChromaDB 操作
│               ├── meta.py       # SQLite 元数据
│               └── assets.py     # 文件存储
├── docs/specs/
│   └── 2026-06-15-memory-system-design.md
└── README.md
```

## 10. 后续扩展（不在首期）

- 权限控制：限制某些 Bot 只能读不能写 shared
- 多模态描述：用 VLM 给图片生成描述后索引
- 记忆压缩：相似内容合并，减少冗余
- Web 管理界面：可视化查看/管理记忆内容
- 备份/导出：定期备份到云存储
