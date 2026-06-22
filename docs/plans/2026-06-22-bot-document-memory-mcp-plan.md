# Bot Document Memory MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a first usable MCP layer for Bot business documents, long-term memory, unified search, and context retrieval while preserving the existing admin/config boundary.

**Architecture:** Add a new `mcp-service` that exposes MCP tools and calls internal service APIs. Extend `data-service` as the metadata and document source of truth, reuse the current `memory-service` parser/chunk/vector capabilities as the new platform retrieval backend, and inject trusted MCP context from `llm-runner` instead of letting the model self-declare identity.

**Tech Stack:** TypeScript services with Vitest and `tsc -b`; FastAPI/ChromaDB memory backend; SQLite metadata stores; Docker Compose for local integration.

---

## Scope

This plan implements the first end-to-end version described in:

```text
docs/specs/2026-06-22-bot-document-memory-mcp-design.md
```

The project is still early, so do not preserve legacy HTTP API compatibility for Bot-facing memory behavior. Existing memory-service capabilities must be included through the new platform boundary:

- Vector search.
- Text, file, URL, and directory ingestion.
- Markdown, PDF, Word, Excel, HTML parsing.
- Chunk metadata.
- Scope/owner isolation.
- Tags and tier lifecycle.
- Original files and assets.
- Stats and cleanup.

## File Structure

Create:

- `services/mcp-service/package.json`: service package scripts and dependencies.
- `services/mcp-service/tsconfig.json`: TypeScript project config.
- `services/mcp-service/Dockerfile`: Docker build for local compose.
- `services/mcp-service/src/main.ts`: HTTP server bootstrap.
- `services/mcp-service/src/server.ts`: HTTP routes, MCP tool dispatch, health endpoint.
- `services/mcp-service/src/context.ts`: trusted context parsing and signed runner token validation.
- `services/mcp-service/src/tools.ts`: tool input parsing and permission checks.
- `services/mcp-service/src/dataClient.ts`: internal `data-service` client.
- `services/mcp-service/src/memoryBackendClient.ts`: internal vector/parser backend client.
- `services/mcp-service/src/logClient.ts`: internal `log-service` client for tool events.
- `services/mcp-service/src/redact.ts`: tool event summary redaction.
- `services/mcp-service/src/*.test.ts`: focused Vitest coverage for each module.

Modify:

- `package.json`: include `services/mcp-service` in `typecheck` and `build`.
- `deploy/compose/docker-compose.yml`: add `mcp-service`, connect it to `data-service`, `memory-service`, and `log-service`.
- `services/data-service/src/store.ts`: add business document, document version, memory metadata, chunk, asset, and stats contracts.
- `services/data-service/src/sqliteStore.ts`: add SQLite migrations and store implementation.
- `services/data-service/src/server.ts`: add internal endpoints consumed by `mcp-service`.
- `services/data-service/src/*.test.ts`: cover new metadata APIs and config/document separation.
- `services/log-service/src/store.ts`: add `tool_events` contract.
- `services/log-service/src/sqliteStore.ts`: persist tool events.
- `services/log-service/src/server.ts`: add internal tool event routes.
- `services/log-service/src/*.test.ts`: cover event storage and secret redaction expectations.
- `services/llm-runner/src/config.ts`: add MCP endpoint and signing secret config.
- `services/llm-runner/src/runtimes.ts`: inject MCP config/context into Kiro runs.
- `services/llm-runner/src/*.test.ts`: cover trusted context injection and session mapping.
- `services/memory-service/src/main.py`: add new internal scoped backend endpoints if needed, without preserving old Bot-facing namespace API.
- `services/memory-service/src/storage/store.py`: support scope/owner/tier/tag filters and stats needed by MCP.
- `services/memory-service/src/**/*.py`: preserve existing parser/chunk/vector behavior under new request model.

Do not modify:

- Bot admin claim flow except where tests need trusted context fixtures.
- `soul.md` / `agents.md` config-document semantics.
- Enterprise WeChat Secret storage behavior.

## Task 1: Add Shared MCP Contracts

**Files:**

- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/mcp.ts`
- Create: `packages/contracts/src/mcp.test.ts`

- [ ] **Step 1: Write failing contract tests**

Add tests for:

- valid trusted context parsing;
- rejected empty `bot_id`, `user_id`, `conversation_id`;
- `document.create` rejects reserved titles: `soul`, `soul.md`, `agents`, `agents.md`, `AGENTS.md`;
- scope accepts only `system`, `shared`, `bot`, `user`, `session`;
- tier accepts only `core`, `reference`, `temp`.

Run:

```bash
npm test -- packages/contracts/src/mcp.test.ts
```

Expected: FAIL because `mcp.ts` does not exist.

- [ ] **Step 2: Implement minimal contract module**

Define:

```ts
export type McpScope = "system" | "shared" | "bot" | "user" | "session";
export type McpTier = "core" | "reference" | "temp";

export interface TrustedMcpContext {
  bot_id: string;
  user_id: string;
  conversation_id: string;
  runtime: "mock" | "kiro";
}

export interface DocumentCreateInput {
  scope: McpScope;
  owner_id: string;
  title: string;
  doc_type: string;
  content: string;
  tags?: string[];
  visibility?: "private" | "bot" | "shared";
  tier?: McpTier;
}
```

Also add parsers:

```ts
parseTrustedMcpContext(value: unknown): TrustedMcpContext
parseDocumentCreateInput(value: unknown): DocumentCreateInput
parseMcpScope(value: unknown): McpScope
parseMcpTier(value: unknown): McpTier
isReservedConfigDocumentTitle(value: string): boolean
```

- [ ] **Step 3: Export contracts**

Update `packages/contracts/src/index.ts`:

```ts
export * from "./llm-runner.js";
export * from "./mcp.js";
```

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- packages/contracts/src/mcp.test.ts
npm run typecheck
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/index.ts packages/contracts/src/mcp.ts packages/contracts/src/mcp.test.ts
git commit -m "Add MCP shared contracts"
```

## Task 2: Extend Data Service Metadata Model

**Files:**

- Modify: `services/data-service/src/store.ts`
- Modify: `services/data-service/src/sqliteStore.ts`
- Modify: `services/data-service/src/store.test.ts`
- Modify: `services/data-service/src/sqliteStore.test.ts`

- [ ] **Step 1: Write failing store tests**

Cover:

- `createBusinessDocument` creates document version 1 and does not accept reserved config titles.
- `updateBusinessDocument` creates version 2 and preserves version 1.
- `listBusinessDocuments` excludes `soul.md` and `agents.md`.
- `createMemoryRecord` stores scope, owner, tags, tier, source metadata.
- `recordChunks` stores chunks for both documents and memories.
- `recordAsset` stores original file or URL snapshot metadata.
- `getMemoryStats` returns memory count, chunk count, tier distribution, and storage bytes.

Run:

```bash
npm test -- services/data-service/src/store.test.ts services/data-service/src/sqliteStore.test.ts
```

Expected: FAIL because APIs do not exist.

- [ ] **Step 2: Add store contracts**

Add interfaces matching the spec:

```ts
BusinessDocumentRecord
BusinessDocumentVersionRecord
MemoryRecord
ChunkRecord
AssetRecord
MemoryStats
CreateBusinessDocumentInput
UpdateBusinessDocumentInput
CreateMemoryRecordInput
RecordChunksInput
RecordAssetInput
```

Add methods:

```ts
createBusinessDocument(input): BusinessDocumentRecord
updateBusinessDocument(input): BusinessDocumentVersionRecord
getBusinessDocument(documentId, version?): BusinessDocumentVersionRecord | undefined
listBusinessDocuments(query): BusinessDocumentRecord[]
createMemoryRecord(input): MemoryRecord
listMemories(query): MemoryRecord[]
recordChunks(input): ChunkRecord[]
recordAsset(input): AssetRecord
getMemoryStats(query): MemoryStats
```

- [ ] **Step 3: Add SQLite migrations**

Create tables:

```text
business_documents
business_document_versions
business_document_tags
memories
memory_tags
chunks
assets
chunk_assets
```

Use `insert if not exists` style migrations in existing `migrate(db)`.

- [ ] **Step 4: Implement SQLite methods**

Rules:

- Reject config document titles before insert.
- Generate IDs with `crypto.randomUUID()`.
- Store tags in join tables.
- Store chunk `source_type` as `document` or `memory`.
- Use `status=active` by default.
- Increment document version on update.

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- services/data-service/src/store.test.ts services/data-service/src/sqliteStore.test.ts
npm run typecheck
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add services/data-service/src/store.ts services/data-service/src/sqliteStore.ts services/data-service/src/store.test.ts services/data-service/src/sqliteStore.test.ts
git commit -m "Add document and memory metadata store"
```

## Task 3: Add Data Service Internal APIs

**Files:**

- Modify: `services/data-service/src/server.ts`
- Modify: `services/data-service/src/server.test.ts`

- [ ] **Step 1: Write failing HTTP tests**

Add tests for:

- `POST /internal/documents`
- `PATCH /internal/documents/{document_id}`
- `GET /internal/documents/{document_id}`
- `GET /internal/documents`
- `POST /internal/memories`
- `GET /internal/memories`
- `POST /internal/chunks`
- `POST /internal/assets`
- `GET /internal/memory-stats`

Run:

```bash
npm test -- services/data-service/src/server.test.ts
```

Expected: FAIL with `404`.

- [ ] **Step 2: Implement handlers**

Use existing `jsonResponse` and `errorResponse` patterns. Require `scope`, `owner_id`, and non-empty IDs. Do not expose Enterprise WeChat Secret in any response.

- [ ] **Step 3: Verify**

Run:

```bash
npm test -- services/data-service/src/server.test.ts
npm run typecheck
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add services/data-service/src/server.ts services/data-service/src/server.test.ts
git commit -m "Expose internal document memory APIs"
```

## Task 4: Extend Log Service Tool Events

**Files:**

- Modify: `services/log-service/src/store.ts`
- Modify: `services/log-service/src/sqliteStore.ts`
- Modify: `services/log-service/src/server.ts`
- Modify: `services/log-service/src/store.test.ts`
- Modify: `services/log-service/src/sqliteStore.test.ts`
- Modify: `services/log-service/src/server.test.ts`

- [ ] **Step 1: Write failing tests**

Cover:

- `recordToolEvent` persists tool name, context IDs, target, status, error code, duration.
- `recordToolEvent` redacts `secret`, `api_key`, `claim_code`, `token` in summaries.
- `GET /internal/tool-events?bot_id=...` lists events.

Run:

```bash
npm test -- services/log-service/src/store.test.ts services/log-service/src/sqliteStore.test.ts services/log-service/src/server.test.ts
```

Expected: FAIL because tool event API does not exist.

- [ ] **Step 2: Implement store and SQLite table**

Add `tool_events` table:

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

- [ ] **Step 3: Implement HTTP routes**

Add:

```text
POST /internal/tool-events
GET /internal/tool-events
```

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- services/log-service/src/store.test.ts services/log-service/src/sqliteStore.test.ts services/log-service/src/server.test.ts
npm run typecheck
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add services/log-service/src
git commit -m "Add MCP tool event logging"
```

## Task 5: Add MCP Service Skeleton and Trusted Context

**Files:**

- Create: `services/mcp-service/package.json`
- Create: `services/mcp-service/tsconfig.json`
- Create: `services/mcp-service/Dockerfile`
- Create: `services/mcp-service/src/main.ts`
- Create: `services/mcp-service/src/server.ts`
- Create: `services/mcp-service/src/context.ts`
- Create: `services/mcp-service/src/context.test.ts`
- Create: `services/mcp-service/src/server.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests**

Tests:

- `GET /health` returns service status.
- requests under `/mcp/bots/{bot_id}/sessions/{conversation_id}` require `x-runner-token`.
- signed token must match path `bot_id` and `conversation_id`.
- mismatched token returns `permission_denied`.

Run:

```bash
npm test -- services/mcp-service/src/context.test.ts services/mcp-service/src/server.test.ts
```

Expected: FAIL because service does not exist.

- [ ] **Step 2: Implement service package**

Use the same scripts as other TypeScript services:

```json
{
  "name": "@my-agent-toolkit/mcp-service",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/main.js",
  "scripts": {
    "dev": "tsx src/main.ts",
    "start": "node dist/main.js",
    "test": "vitest run",
    "typecheck": "tsc -b",
    "build": "tsc -b"
  },
  "dependencies": {
    "@my-agent-toolkit/contracts": "0.1.0"
  }
}
```

- [ ] **Step 3: Implement token signing**

Use HMAC SHA-256:

```ts
signRunnerToken(secret, context): string
verifyRunnerToken(secret, token, expectedContext): TrustedMcpContext
```

Token payload includes:

```json
{
  "bot_id": "testbot",
  "user_id": "user-a",
  "conversation_id": "conv-a",
  "runtime": "kiro",
  "iat": 1782060000
}
```

- [ ] **Step 4: Wire root build**

Update root scripts:

```json
"typecheck": "tsc -b packages/contracts services/llm-runner services/data-service services/bot-host services/log-service services/control-api services/mcp-service",
"build": "tsc -b packages/contracts services/llm-runner services/data-service services/bot-host services/log-service services/control-api services/mcp-service"
```

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- services/mcp-service/src/context.test.ts services/mcp-service/src/server.test.ts
npm run typecheck
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add package.json services/mcp-service
git commit -m "Add MCP service trusted context"
```

## Task 6: Implement Document MCP Tools

**Files:**

- Create: `services/mcp-service/src/tools.ts`
- Create: `services/mcp-service/src/tools.test.ts`
- Create: `services/mcp-service/src/dataClient.ts`
- Create: `services/mcp-service/src/dataClient.test.ts`
- Modify: `services/mcp-service/src/server.ts`
- Modify: `services/mcp-service/src/server.test.ts`

- [ ] **Step 1: Write failing tests**

Cover:

- `document.create` calls `data-service` and rejects config titles.
- `document.update` requires same bot/scope permission.
- `document.get` returns latest version.
- `document.list` filters by scope, owner, doc type.
- `document.search` calls memory backend search over document chunks.

Run:

```bash
npm test -- services/mcp-service/src/tools.test.ts services/mcp-service/src/server.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implement tool dispatch**

Use a JSON HTTP envelope first:

```json
{
  "tool": "document.create",
  "input": {}
}
```

Route:

```text
POST /mcp/bots/{bot_id}/sessions/{conversation_id}/tools/call
```

Response:

```json
{
  "ok": true,
  "result": {}
}
```

Errors:

```json
{
  "ok": false,
  "error": {
    "code": "permission_denied",
    "message": "..."
  }
}
```

- [ ] **Step 3: Implement permissions**

First-version rules:

- `system`: read only.
- `shared`: read; write only if context user is Bot admin later, otherwise disabled in first version.
- `bot`: current Bot only.
- `user`: current user only.
- `session`: current conversation only.

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- services/mcp-service/src/tools.test.ts services/mcp-service/src/server.test.ts
npm run typecheck
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-service/src
git commit -m "Add document MCP tools"
```

## Task 7: Implement Memory and Search MCP Tools

**Files:**

- Modify: `services/mcp-service/src/tools.ts`
- Modify: `services/mcp-service/src/tools.test.ts`
- Create: `services/mcp-service/src/memoryBackendClient.ts`
- Create: `services/mcp-service/src/memoryBackendClient.test.ts`
- Modify: `services/mcp-service/src/server.test.ts`

- [ ] **Step 1: Write failing tests**

Cover:

- `memory.write` stores metadata in data-service and chunks/embeddings in memory backend.
- `memory.search` queries by scope and owner.
- `search.query` merges document and memory results.
- `memory.stats` combines metadata and backend storage statistics.
- Secret-like values are rejected or redacted.

Run:

```bash
npm test -- services/mcp-service/src/tools.test.ts services/mcp-service/src/memoryBackendClient.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implement memory backend client**

The client should call new internal memory backend endpoints using scoped fields:

```json
{
  "scope": "bot",
  "owner_id": "testbot",
  "content": "...",
  "tags": ["prd"],
  "tier": "core",
  "source_type": "text"
}
```

Do not expose old `namespace` to MCP tool callers.

- [ ] **Step 3: Implement search result normalization**

Return result entries with:

```text
source
id
title
snippet
score
metadata
```

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- services/mcp-service/src/tools.test.ts services/mcp-service/src/memoryBackendClient.test.ts services/mcp-service/src/server.test.ts
npm run typecheck
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add services/mcp-service/src
git commit -m "Add memory and search MCP tools"
```

## Task 8: Add Ingestion Tools and Preserve Existing Memory Capabilities

**Files:**

- Modify: `services/memory-service/src/main.py`
- Modify: `services/memory-service/src/storage/store.py`
- Modify: `services/memory-service/src/core/chunker.py`
- Modify: `services/memory-service/src/parsers/dispatch.py`
- Modify: `services/mcp-service/src/tools.ts`
- Modify: `services/mcp-service/src/tools.test.ts`
- Modify: `services/mcp-service/src/memoryBackendClient.ts`
- Modify: `services/mcp-service/src/memoryBackendClient.test.ts`

- [ ] **Step 1: Add Python backend tests or smoke script**

If no Python test framework exists, add a small smoke script under:

```text
services/memory-service/scripts/smoke_scoped_backend.py
```

It must validate:

- store text;
- ingest Markdown file;
- fetch URL using a local test server or mocked content path;
- scan authorized directory;
- search by scope/owner/tag;
- stats by scope/owner.

- [ ] **Step 2: Add internal scoped backend endpoints**

Add internal endpoints:

```text
POST /internal/v1/memories
POST /internal/v1/memories/search
POST /internal/v1/memories/ingest-file
POST /internal/v1/memories/fetch-url
POST /internal/v1/memories/scan
GET /internal/v1/memories/stats
POST /internal/v1/lifecycle/cleanup
```

Keep old endpoints only if needed for existing local smoke tests, but do not route Bot MCP traffic through legacy namespace inputs.

- [ ] **Step 3: Implement MCP tools**

Add:

```text
document.ingest_file
document.ingest_url
document.scan
memory.ingest_file
memory.ingest_url
memory.scan
memory.delete
```

For `document.ingest_*`, create business document metadata and version in `data-service`, then index chunks in memory backend with `source_type=document`.

For `memory.ingest_*`, create memory metadata and index chunks with `source_type=memory`.

- [ ] **Step 4: Enforce authorized directory refs**

MCP input must use `directory_ref`, not raw host paths. `mcp-service` maps refs from environment config:

```text
MCP_ALLOWED_DIRECTORY_REFS=knowledge-base:/data/knowledge,prd:/data/prd
```

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- services/mcp-service/src/tools.test.ts services/mcp-service/src/memoryBackendClient.test.ts
npm run typecheck
python services/memory-service/scripts/smoke_scoped_backend.py
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add services/memory-service services/mcp-service/src
git commit -m "Add scoped ingestion MCP tools"
```

## Task 9: Inject MCP into LLM Runner and Kiro Runtime

**Files:**

- Modify: `services/llm-runner/src/config.ts`
- Modify: `services/llm-runner/src/config.test.ts`
- Modify: `services/llm-runner/src/runtimes.ts`
- Modify: `services/llm-runner/src/runtimes.test.ts`
- Modify: `services/llm-runner/src/server.test.ts`

- [ ] **Step 1: Write failing tests**

Cover:

- config reads `MCP_SERVICE_URL` and `MCP_RUNNER_SECRET`;
- Kiro runtime receives signed MCP context for `bot_id`, `user_id`, `conversation_id`;
- `runner_session_id` remains stable per Bot/user/conversation runtime session;
- mock runtime remains unaffected.

Run:

```bash
npm test -- services/llm-runner/src/config.test.ts services/llm-runner/src/runtimes.test.ts services/llm-runner/src/server.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implement config**

Add:

```ts
mcp?: {
  service_url: string;
  runner_secret: string;
}
```

- [ ] **Step 3: Inject MCP config**

When runtime is Kiro, pass environment variables or CLI config payload:

```text
BOT_MCP_URL=http://mcp-service:8700/mcp/bots/{bot_id}/sessions/{conversation_id}
BOT_MCP_RUNNER_TOKEN={signed-token}
```

If Kiro requires a config file, generate it inside the runner temp workspace and pass the path to Kiro.

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- services/llm-runner/src/config.test.ts services/llm-runner/src/runtimes.test.ts services/llm-runner/src/server.test.ts
npm run typecheck
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add services/llm-runner/src
git commit -m "Inject MCP context into Kiro runtime"
```

## Task 10: Wire Docker Compose

**Files:**

- Modify: `deploy/compose/docker-compose.yml`
- Modify: `deploy/compose/README.md`
- Modify: `services/mcp-service/Dockerfile`
- Modify: `services/memory-service/Dockerfile`

- [ ] **Step 1: Add compose service**

Add:

```yaml
mcp-service:
  build:
    context: ../..
    dockerfile: services/mcp-service/Dockerfile
  environment:
    PORT: "8700"
    DATA_SERVICE_URL: "http://data-service:8300"
    MEMORY_BACKEND_URL: "http://memory-service:8100"
    LOG_SERVICE_URL: "http://log-service:8500"
    MCP_RUNNER_SECRET: "dev-only-runner-secret"
    MCP_ALLOWED_DIRECTORY_REFS: "knowledge-base:/data/knowledge,prd:/data/prd"
  ports:
    - "8700:8700"
  depends_on:
    data-service:
      condition: service_healthy
    memory-service:
      condition: service_healthy
    log-service:
      condition: service_healthy
```

Add `memory-service` to main compose if it is not already present.

- [ ] **Step 2: Update llm-runner compose env**

Add:

```yaml
MCP_SERVICE_URL: "http://mcp-service:8700"
MCP_RUNNER_SECRET: "dev-only-runner-secret"
```

- [ ] **Step 3: Verify compose config**

Run:

```bash
docker compose -f deploy/compose/docker-compose.yml config
```

Expected: exit 0 and includes `mcp-service`.

- [ ] **Step 4: Commit**

```bash
git add deploy/compose services/mcp-service/Dockerfile services/memory-service/Dockerfile
git commit -m "Wire MCP service into compose"
```

## Task 11: End-to-End MCP Smoke Test

**Files:**

- Create: `scripts/smoke-mcp-flow.mjs`
- Modify: `package.json`
- Modify: `deploy/compose/README.md`

- [ ] **Step 1: Create smoke script**

The script should:

1. Create or reuse a Bot in `data-service`.
2. Resolve a conversation.
3. Generate a signed runner token.
4. Call `document.create`.
5. Call `memory.write`.
6. Call `search.query`.
7. Call `memory.stats`.
8. Query `log-service` for tool events.
9. Assert `soul.md` and `agents.md` are not in business document results.

- [ ] **Step 2: Add script command**

Add root package script:

```json
"smoke:mcp": "node scripts/smoke-mcp-flow.mjs"
```

- [ ] **Step 3: Run compose smoke**

Run:

```bash
docker compose -f deploy/compose/docker-compose.yml up -d --build
npm run smoke:mcp
```

Expected:

```text
document.create ok
memory.write ok
search.query ok
memory.stats ok
tool_events ok
config documents excluded ok
```

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/smoke-mcp-flow.mjs deploy/compose/README.md
git commit -m "Add MCP smoke flow"
```

## Task 12: WebUI Read-Only Visibility

**Files:**

- Modify: `services/control-api/src/server.ts`
- Modify: `services/control-api/src/server.test.ts`

- [ ] **Step 1: Write failing tests**

Cover:

- channel detail shows business documents from new internal data-service API;
- channel detail shows memory stats;
- channel detail keeps `soul.md` and `agents.md` only under Bot config section;
- tool events are visible as summaries only.

Run:

```bash
npm test -- services/control-api/src/server.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Implement read-only API aggregation**

Add backend calls for:

```text
GET /internal/documents?bot_id=...
GET /internal/memory-stats?scope=bot&owner_id=...
GET /internal/tool-events?bot_id=...
```

Do not add write UI for MCP tools in first version.

- [ ] **Step 3: Verify**

Run:

```bash
npm test -- services/control-api/src/server.test.ts
npm run typecheck
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add services/control-api/src
git commit -m "Show MCP documents memory and tool events"
```

## Final Verification

Run all checks:

```bash
npm test
npm run typecheck
docker compose -f deploy/compose/docker-compose.yml config
docker compose -f deploy/compose/docker-compose.yml up -d --build
npm run smoke:mcp
```

Expected:

- Vitest passes.
- TypeScript project build passes.
- Compose config is valid.
- Compose starts all core services including `mcp-service`.
- Smoke script confirms document creation, memory write, vector search, stats, tool event logging, and config-document exclusion.

## Requirement Coverage Checklist

- [ ] `soul.md` and `agents.md` remain config documents, not business documents.
- [ ] Bot cannot create or update config documents via MCP.
- [ ] Business documents support create, update, get, list, search.
- [ ] Business documents are versioned.
- [ ] Long-term memories support write, search, delete/archive, stats.
- [ ] File ingestion covers existing parser capabilities.
- [ ] URL ingestion is available.
- [ ] Authorized directory scanning is available.
- [ ] Chunks and embeddings are generated for documents and memories.
- [ ] Scope/owner isolation replaces Bot-visible namespace.
- [ ] Tags and tier lifecycle are retained.
- [ ] Original files, URL snapshots, and parsed assets have storage references.
- [ ] `search.query` searches documents and memories together.
- [ ] `context.get` returns relevant allowed context and never returns config documents.
- [ ] `llm-runner` injects trusted MCP context.
- [ ] Kiro runtime can call the MCP service through the runner-provided endpoint.
- [ ] Tool events are logged with redacted summaries.
- [ ] WebUI can show business documents, memory stats, and tool event summaries separately from Bot config.

