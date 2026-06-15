# Memory Service API 规范

基地址：`${MEMORY_API_URL}`（如 `http://localhost:8100`）

## 存入文本

```
POST /api/v1/memories
Content-Type: application/json

{
  "namespace": "product",
  "content": "文本内容",
  "tags": ["PRD", "注册"],
  "tier": "core",          // core | reference | temp
  "source": "text",
  "metadata": { "title": "可选标题" }
}

→ 200 { "id": "mem_xxx", "chunks": 3 }
```

## 存入文件

```
POST /api/v1/memories/ingest
Content-Type: multipart/form-data

file: <binary>
namespace: product
tags: PRD,注册
tier: core

→ 200 { "id": "mem_xxx", "chunks": 12, "filename": "xxx.md" }
```

## 抓取 URL

```
POST /api/v1/memories/fetch
Content-Type: application/json

{
  "namespace": "product",
  "url": "https://...",
  "tags": ["PRD"],
  "tier": "core"
}

→ 200 { "id": "mem_xxx", "chunks": 8 }
```

## 扫描目录

```
POST /api/v1/memories/scan
Content-Type: application/json

{
  "namespace": "product",
  "directory": "/path/to/docs",
  "tags": ["PRD"],
  "tier": "core",
  "incremental": true
}

→ 200 { "scanned": 5, "files": [...] }
```

## 检索

```
POST /api/v1/memories/search
Content-Type: application/json

{
  "namespace": "product",
  "query": "注册验证码",
  "tags": ["PRD"],           // 可选
  "limit": 5,
  "include_shared": true
}

→ 200 {
  "results": [
    {
      "chunk_id": "mem_xxx_chk0",
      "content": "相关文本片段...",
      "score": 0.87,
      "tags": ["PRD"],
      "tier": "core",
      "title": "",
      "filename": "注册PRD.md",
      "created_at": "2026-06-10T10:00:00"
    }
  ]
}
```

## 删除

```
DELETE /api/v1/memories/{memory_id}
→ 200 { "deleted": "mem_xxx" }

POST /api/v1/memories/delete
{ "namespace": "product", "tags": ["旧版本"] }
→ 200 { "deleted_count": 3 }
```

## 统计

```
GET /api/v1/memories/stats?namespace=product
→ 200 { "total_memories": 42, "total_chunks": 358, "by_tier": {...} }
```

## 生命周期清理

```
POST /api/v1/lifecycle/cleanup
→ 200 { "temp_deleted": 5, "reference_archived": 2 }
```

## 健康检查

```
GET /health
→ 200 { "status": "ok" }
```
