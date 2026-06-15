# 记忆系统设计文档

## 概述

为企业微信 CLI 机器人提供长期记忆能力。Bot 能积累和检索领域知识，在生成新内容时参考历史知识。

## 架构

```
企业微信用户
    ↓ 消息/文件/URL/指令
wecom-cli-bot (各 Bot)
    ↓ HTTP API
Memory Service (mini Docker 容器)
  ├── FastAPI 接口
  ├── 本地 Embedding (bge-m3)
  ├── 向量索引 (ChromaDB)
  ├── 元数据 (SQLite)
  └── 文件存储 (本地磁盘)
```

## Memory Service

### 技术栈

- Python FastAPI
- Embedding：`bge-m3`（BAAI，支持中文，CPU 可运行）
- 向量库：ChromaDB（内嵌式，无需额外服务）
- 元数据：SQLite
- 文件存储：本地磁盘 `data/assets/`

### API 接口

#### 存入

```
POST /api/v1/memories
{
  "namespace": "product",
  "content": "文本内容",
  "tags": ["PRD", "IM", "群组"],
  "tier": "core",          // core | reference | temp
  "source": "file",        // file | text | url | auto
  "metadata": {
    "filename": "xxx.md",
    "user_id": "xxx",
    "created_at": "2026-06-15T09:00:00Z"
  }
}
```

#### 存入文件

```
POST /api/v1/memories/ingest
Content-Type: multipart/form-data

file: <binary>
namespace: product
tags: PRD,IM
tier: core
```

#### 检索

```
POST /api/v1/memories/search
{
  "namespace": "product",
  "query": "用户注册流程",
  "tags": ["PRD"],          // 可选，标签粗筛
  "limit": 5,
  "include_shared": true    // 是否包含 shared 命名空间
}

Response:
{
  "results": [
    {
      "id": "xxx",
      "content": "片段文本...",
      "score": 0.87,
      "tags": ["PRD", "注册"],
      "tier": "core",
      "metadata": { "filename": "注册模块PRD.md", ... },
      "assets": ["data/assets/xxx.png"]  // 关联图片路径
    }
  ]
}
```

#### 删除

```
DELETE /api/v1/memories?namespace=product&query=注册流程
```

#### 统计

```
GET /api/v1/memories/stats?namespace=product
```

### 知识分层与生命周期

| 层级 | 说明 | 生命周期 |
|------|------|----------|
| core | PRD、设计文档、决策记录 | 永久，手动删除 |
| reference | 对话摘要、会议纪要 | 90 天未访问归档 |
| temp | 对话上下文提取 | 7 天自动清理 |

### 命名空间

- `product/` — 产品 Bot
- `qa/` — QA Bot
- `jira/` — Jira Bot
- `shared/` — 跨 Bot 共享

### 文档解析

| 格式 | 解析方式 |
|------|----------|
| Markdown / TXT | 直接读取，按段落分块 |
| PDF | pymupdf 提取文本 |
| Word (.docx) | python-docx |
| Excel | openpyxl 按 sheet 提取 |
| HTML | beautifulsoup 正文提取 |
| 图片 | 仅存原图，关联到所属文档 |

### 分块策略

- 按 512 token 窗口切分
- 128 token 重叠保留上下文
- 保留段落边界，不切断句子

## Bot Memory Skill

### 触发条件

当 Bot 配置中启用了 memory 时生效。

### 用户指令

| 指令 | 功能 |
|------|------|
| `/remember <文本>` | 手动存入核心记忆 |
| `/remember #tag1 #tag2 <文本>` | 带标签存入 |
| `/fetch <url>` | 抓取 URL 内容存入 |
| `/scan [目录]` | 扫描 workspace 文件增量索引 |
| `/memory` | 查看记忆统计 |
| `/forget <关键词>` | 删除匹配的记忆 |
| 发送文件 | 自动解析存入记忆 |

### 自动行为

- 对话结束后，Bot 提取关键结论/决策，存为 reference 层
- 检索时机：每次用户发消息，先用消息内容检索相关记忆，注入 prompt context

### Bot 集成

在 `promptBuilder` 中增加记忆检索步骤：

```
用户消息 → 调用 Memory API search → 取 top 5 结果 → 注入 prompt 的 context 段
```

prompt 结构：

```
# Soul
...

# 相关记忆
[自动注入的相关历史知识片段]

# User Message
用户的问题
```

## 部署

```yaml
# docker-compose.yml (mini 上)
services:
  memory-service:
    build: ./services/memory-service
    ports:
      - "8100:8000"
    volumes:
      - ./data/memory:/app/data
    restart: unless-stopped
```

Bot 的 docker-compose 中增加环境变量：

```yaml
environment:
  - MEMORY_API_URL=http://host.docker.internal:8100
  - MEMORY_NAMESPACE=product
```

## 文件结构

```
my-agent-toolkit/
├── .agents/skills/bot-memory/
│   ├── SKILL.md
│   └── references/
│       └── api-spec.md
├── services/memory-service/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── requirements.txt
│   └── src/
│       ├── main.py          # FastAPI app
│       ├── embedding.py     # bge-m3 加载和推理
│       ├── storage.py       # ChromaDB + SQLite
│       ├── parser.py        # 文档解析
│       └── chunker.py       # 分块逻辑
```
