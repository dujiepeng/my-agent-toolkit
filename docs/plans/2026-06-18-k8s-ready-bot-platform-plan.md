# K8s-Ready Bot Platform Implementation Plan

> **For agentic workers:** implement this plan in order. Keep each phase independently deployable and verified before moving to the next phase.

**Goal:** Build a standalone K8s-ready bot platform with separate management, LLM runtime, and data planes while keeping Docker Compose as the first working deployment target.

**Architecture:** Introduce `llm-runner` first, then `data-service`, then `bot-factory`, then `bot-host`. Existing `.agents/skills/wecom-cli-bot` code is a migration source and compatibility target, not the required shape for the new platform.

**Tech Stack:** Node.js 22, TypeScript ESM, FastAPI/Python for existing memory-service, Docker Compose first, Kubernetes manifests/Helm later.

---

## Phase 0: Baseline and Standalone Project Skeleton

**Goal:** Freeze current behavior, define interfaces, and create the standalone project layout.

- [ ] Record current WeCom bot message flow, admin claim flow, initialization flow, document flow, and memory flow.
- [ ] Create standalone directories:
  - `services/llm-runner/`
  - `services/data-service/`
  - `services/bot-factory/`
  - `services/bot-host/`
  - `packages/contracts/`
  - `packages/shared/`
  - `deploy/compose/`
  - `deploy/k8s/`
- [ ] Add API contract drafts under `docs/contracts/` for:
  - `llm-runner`
  - `data-service`
  - control API
- [ ] Add fixture examples for streaming chat, stop, session resume, document generation, and initialization.
- [ ] Keep the existing template tests passing as compatibility tests:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm test
npm run typecheck
```

## Phase 1: Add llm-runner

**Goal:** Move provider CLI execution out of business bot containers.

**Files/Dirs:**

- Create `services/llm-runner/`
- Create `services/llm-runner/src/`
- Create `deploy/compose/llm-runner.compose.yml` or a root compose include
- Create shared request/response types in `packages/contracts/`
- Add a small compatibility adapter from the existing WeCom bot template only after the runner API works

**Steps:**

- [ ] Define `POST /v1/chat` with streaming output and `run_id`.
- [ ] Define `POST /v1/stop`.
- [ ] Define `GET /health`.
- [ ] Implement a `kiro-cli` adapter inside `llm-runner`.
- [ ] Add runner-managed process timeout, stop signal, and per-user concurrency guard.
- [ ] Add redacted run logs.
- [ ] Add a runner auth volume path such as `/runner/auth/kiro`.
- [ ] Add runner workspace path such as `/runner/workspaces/<bot_id>/<user_id>`.
- [ ] Add a client package or helper for bot-host/template callers to call `llm-runner`.
- [ ] Keep direct `kiro-cli` mode temporarily for migration.
- [ ] Verify with Docker Compose:

```bash
docker compose up -d llm-runner
curl http://localhost:8200/health
```

## Phase 2: Move Sessions to llm-runner

**Goal:** Keep provider-specific session details inside `llm-runner`.

- [ ] Add runner session records:
  - `runner_session_id`
  - `bot_id`
  - `user_id`
  - `conversation_id`
  - `runtime`
  - `provider_session_id`
  - `workspace_ref`
  - timestamps
- [ ] Add `GET /v1/sessions`.
- [ ] Add `POST /v1/sessions` for new/reset/open.
- [ ] Map `/history`, `/open`, `/new`, and `/name` semantics to runner APIs in contracts first.
- [ ] Add tests for numeric initialization replies with runner session context.
- [ ] Remove Kiro-specific session parsing from bot-host/template code after runner mode is stable.

## Phase 3: Add data-service

**Goal:** Centralize bot data and sharing rules.

**Files/Dirs:**

- Create `services/data-service/`
- Create `packages/contracts/data-service.ts` or equivalent OpenAPI schema
- Consider whether to reuse or wrap `services/memory-service/`

**Data scopes:**

- `system`
- `shared`
- `bot`
- `user`
- `session`

**Steps:**

- [ ] Define bot registry APIs:
  - create bot
  - get bot config
  - update bot config
  - list bots
- [ ] Define admin state APIs:
  - create claim
  - verify claim
  - transfer admin
  - mark ready
- [ ] Define file APIs:
  - read/write soul
  - read/write instructions
  - store generated documents
  - list shared docs
- [ ] Define history APIs:
  - append message
  - get recent conversation
  - list sessions
- [ ] Add permission checks for every scope.
- [ ] Store files in a volume-backed directory first.
- [ ] Keep existing memory-service as the vector backend initially.
- [ ] Add bot-host client support for data-service.
- [ ] Add a migration adapter for the existing WeCom bot template after data-service APIs are stable.
- [ ] Verify that deleting/recreating a bot container does not lose data.

## Phase 4: Add bot-factory

**Goal:** Provide a default management bot that can create and operate other bots through controlled APIs.

**Files/Dirs:**

- Create `services/bot-factory/`
- Do not implement factory primarily as an Agent Skill. It is a platform service with a WeCom management entrypoint.

**Steps:**

- [ ] Add platform admin claim flow for factory.
- [ ] Add bot creation wizard:
  - bot id/name
  - WeCom credential collection method
  - role and goal
  - memory/docs sharing policy
  - runtime selection
- [ ] Add secret write flow that never exposes raw secrets to LLM prompts.
- [ ] Add claim-code generation for newly created bots.
- [ ] Add status/log commands with redaction.
- [ ] Add start/stop/restart commands through the control API.
- [ ] Ensure bot-factory does not mount Docker socket directly.

## Phase 5: Control API

**Goal:** Centralize workload lifecycle operations behind a safe API.

- [ ] Implement Compose control first:
  - start bot
  - stop bot
  - restart bot
  - status
  - redacted logs
- [ ] Make operations idempotent.
- [ ] Prevent overwriting `.env`, admin state, history, and auth paths.
- [ ] Add audit logs for all control actions.
- [ ] Keep the API shape compatible with a later Kubernetes implementation.

## Phase 5.5: Add bot-host

**Goal:** Provide a standalone WeCom message entrypoint that can host one or more business bot workers.

- [ ] Create `services/bot-host/`.
- [ ] Load bot registry and runtime config from `data-service`.
- [ ] Route messages by WeCom bot identity.
- [ ] Enforce admin/initialization state via `data-service`.
- [ ] Build prompts using data-service context.
- [ ] Stream responses from `llm-runner` back to WeCom.
- [ ] Keep existing template bot as a compatibility path until bot-host is stable.

## Phase 6: K8s-Ready Packaging

**Goal:** Prepare Kubernetes deployment without making it mandatory.

- [ ] Create `deploy/k8s/base/` manifests or a Helm chart draft.
- [ ] Map services:
  - `llm-runner` Deployment or StatefulSet
  - `data-service` Deployment/StatefulSet
  - `bot-factory` Deployment
  - business bot Deployment or bot-host Deployment
- [ ] Use `Secret` for small sensitive values.
- [ ] Use `PVC` for Kiro CLI state, runner workspaces, file storage, and database files.
- [ ] Use `ConfigMap` for non-sensitive runtime config.
- [ ] Add narrow RBAC for the control API.
- [ ] Document migration from Compose volumes to PVCs.

## Verification Matrix

- [ ] Existing template compatibility tests pass.
- [ ] Existing memory-service health check passes.
- [ ] `llm-runner` health check passes.
- [ ] `llm-runner` can run `kiro-cli whoami`.
- [ ] A bot-host worker can initialize through runner mode.
- [ ] A numeric wizard reply does not reset to the first question.
- [ ] Shared docs and private docs are isolated correctly.
- [ ] Bot container recreation preserves data through data-service.
- [ ] Factory can create a new bot without printing secrets.
- [ ] Control API cannot perform arbitrary shell operations.

## Rollout Strategy

1. Keep the current PRD bot running on the existing template.
2. Add standalone `llm-runner` in parallel and test with a separate client.
3. Add standalone `data-service`.
4. Add standalone `bot-host` and migrate one bot to it.
5. Add `bot-factory` after data-service owns bot registry and admin state.
6. Generate K8s manifests only after Compose contracts are stable.

## Risks

- Kiro CLI state format may change and affect runner auth.
- Streaming behavior may differ across future CLI providers.
- Central data-service becomes a critical dependency.
- Factory/control APIs can become dangerous if permission checks are too broad.
- Premature K8s migration could slow down core service-boundary work.
