# K8s-Ready Bot Platform Design

## Goal

Build a standalone bot platform in this repository. The existing `.agents/skills/wecom-cli-bot` template is a migration source and compatibility target, but the new platform is not constrained to the Agent Skill directory shape.

The platform has clear service boundaries:

- `bot-factory`: the management entrypoint for creating and operating bots.
- `llm-runner`: a provider-agnostic LLM runtime gateway.
- `data-service`: the source of truth for bot configuration, files, history, memory metadata, and sharing rules.
- `bot-host`: a thin WeCom message bridge that can run one or many business bot workers.

The first implementation should remain Docker Compose friendly, but the service boundaries must be suitable for a later Kubernetes deployment.

## Non-Goals

- Do not migrate to Kubernetes in the first implementation phase.
- Do not implement multiple LLM providers immediately; start with `kiro-cli`.
- Do not give a chat-facing bot direct Docker socket or cluster-admin permissions.
- Do not store real WeCom secrets, Kiro auth material, or LLM provider credentials in Git.
- Do not let ordinary business bots read or mutate other bots' private data.
- Do not force new platform code to live under `.agents/skills/`.

## Target Architecture

```text
bot-factory
  - WeCom management entrypoint
  - guides bot creation and operations
  - calls data-service and a control API
  - optionally calls llm-runner for generated configuration help

bot-host / business-bot worker
  - receives WeCom messages
  - enforces bot-level admin and user interaction rules
  - reads/writes state through data-service
  - sends prompts to llm-runner

llm-runner
  - exposes provider-neutral chat/stop/session APIs
  - owns CLI/runtime auth, sessions, process lifecycle, timeouts, and logs
  - adapts requests to kiro-cli first, future providers later

data-service
  - owns bot registry, config, soul, instructions, admin state, history, docs, and sharing metadata
  - exposes scoped data APIs
  - uses file storage, database, and vector search backends

memory/vector backend
  - remains separate initially
  - may later become a data-service backend
```

## Service Boundaries

### bot-factory

`bot-factory` is a management-plane bot, not a normal business bot.

It may:

- Guide the operator through creating a bot.
- Create and update bot records through `data-service`.
- Generate administrator claim codes through a controlled API.
- Start, stop, and restart bot workloads through a limited control API.
- Show status and redacted log summaries.

It must not:

- Mount Docker socket directly in the chat-facing container.
- Execute arbitrary shell commands.
- Read or print raw `.env`, provider auth, or Kiro state.
- Bypass data-service sharing and permission rules.

### llm-runner

`llm-runner` is a generic runtime gateway. Bot containers do not know whether the underlying provider is Kiro, Codex, Claude, or an HTTP LLM.

External API shape:

```text
POST /v1/chat
POST /v1/stop
GET  /v1/sessions
POST /v1/sessions
GET  /health
```

The stable external contract is:

```text
prompt in -> stream out
stop by run_id
session by bot_id + user_id + conversation_id
```

Provider-specific behavior remains internal to runner adapters:

```text
kiro-cli adapter
future codex adapter
future claude adapter
future HTTP model adapter
```

### data-service

`data-service` is the data plane. It owns durable bot data and controls sharing.

Data scopes:

```text
system   platform-only records and audit data
shared   cross-bot docs and memories
bot      one bot's config, soul, instructions, files
user     one user's history and preferences within a bot
session  one conversation/run
```

Examples:

```text
/system/bots/prd-bot/config
/system/bots/prd-bot/admin
/shared/docs/product/
/shared/memory/
/bots/prd-bot/soul.md
/bots/prd-bot/instructions/AGENTS.md
/bots/prd-bot/users/<userId>/history/
/bots/prd-bot/sessions/<sessionId>/
```

### bot-host and business bot workers

A business bot worker should become thin:

- Receive WeCom messages.
- Validate bot admin/user state.
- Ask data-service for soul, instructions, history, and relevant docs.
- Call llm-runner.
- Stream results back to WeCom.
- Persist history and generated documents through data-service.

It should not directly execute provider CLIs or own durable workspace state.

The first standalone project structure should be:

```text
services/
  llm-runner/
  data-service/
  bot-factory/
  bot-host/
packages/
  contracts/
  shared/
deploy/
  compose/
  k8s/
```

The existing skill template can later become an exporter or client of this platform, but should not dictate the internal service layout.

## LLM Runner Runtime Model

Initial runtime config:

```yaml
default_runtime: kiro
runtimes:
  kiro:
    type: cli
    command: kiro-cli
    args: ["chat", "--no-interactive", "--trust-all-tools", "{{prompt}}"]
    input_mode: arg
    session_strategy: kiro-chat
    auth_dir: /runner/auth/kiro
```

The runner maps platform sessions to provider sessions:

```text
runner_session_id
bot_id
user_id
conversation_id
runtime
provider_session_id
workspace_ref
created_at
updated_at
```

Provider auth is runner-owned. For Docker Compose this can be a volume or host bind mount. For Kubernetes this should become a PVC for mutable CLI state such as Kiro's SQLite auth database.

## Data Service Storage Model

The first data-service can be pragmatic:

- SQLite or Postgres for metadata.
- Local volume for file blobs.
- Existing memory-service for vector search.

Later K8s deployment can map these to:

- Postgres for metadata.
- PVC or S3-compatible object storage for files.
- Vector DB or memory-service backend for embeddings.

The important rule is that bot containers do not treat their local filesystem as the source of truth.

## Control Plane

Container creation and restart should be behind a control API, not directly available to the management bot.

Compose-first control API:

```text
POST /v1/control/bots/{bot_id}/start
POST /v1/control/bots/{bot_id}/stop
POST /v1/control/bots/{bot_id}/restart
GET  /v1/control/bots/{bot_id}/status
GET  /v1/control/bots/{bot_id}/logs
```

K8s-later control API can use Kubernetes API permissions with narrow RBAC:

- manage workloads only in the bot platform namespace
- create/update bot-specific Secrets and ConfigMaps
- read pod status and logs
- no privileged pods
- no hostPath mounts
- no cluster-wide secret access

## Kubernetes Mapping

The design should map cleanly to Kubernetes later:

```text
bot-factory   -> Deployment + Service
llm-runner    -> Deployment or StatefulSet + Service + PVC
data-service  -> Deployment/StatefulSet + Service + DB/PVC
business-bot  -> Deployment per bot, or bot-host Deployment
memory        -> existing service or data-service backend
```

K8s object usage:

- `Secret`: small sensitive values such as WeCom secrets and provider API keys.
- `ConfigMap`: non-sensitive runtime and bot templates.
- `PVC`: mutable directories, Kiro CLI state, file storage, caches, and database files.
- `Service`: stable internal URLs between components.
- `RBAC`: limits factory/control API permissions.

Kiro CLI state should use a PVC-like filesystem path, not a K8s Secret, because it is a mutable directory/database rather than a single static token.

## Migration Strategy

Phase 1 introduces standalone `llm-runner` while keeping the current PRD bot running:

```text
bot-host or adapter -> llm-runner -> kiro-cli
```

Phase 2 introduces standalone `data-service` as the source of truth:

```text
bot-host -> data-service for config/history/docs
llm-runner -> data-service for workspace materialization
```

Phase 3 introduces `bot-factory`:

```text
factory-bot -> data-service + control API -> create/manage bots
```

Phase 4 adds Kubernetes manifests or Helm once Compose service contracts are stable.

## Security Rules

- No chat-facing service gets arbitrary shell execution.
- No ordinary bot gets Docker socket or Kubernetes write permissions.
- Secrets are written through controlled APIs or deployment tooling, not model output.
- Provider auth paths are never included in prompts.
- `llm-runner` logs are redacted before storage.
- `data-service` enforces scope checks for every read and write.
- Bot creation and admin reset actions are audited.

## Open Decisions

- Whether first `data-service` should extend the existing memory-service or be a new service.
- Whether to run one container per business bot or a multi-bot host.
- Whether the first control API lives inside `bot-factory`, `llm-runner`, or a separate `runner-control` service.
- Whether Kiro workspaces should be fully materialized per run or persistent per bot/user.
