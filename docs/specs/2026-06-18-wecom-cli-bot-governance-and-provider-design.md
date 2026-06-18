# WeCom CLI Bot Governance and Provider Design

## Goal

Refine `wecom-cli-bot` into a narrower and safer runtime model:

- Keep the CLI provider abstraction, but only ship `kiro-cli` support in the current implementation.
- Require CLI authentication to be completed on the Docker host machine.
- Keep per-bot and per-user CLI sessions isolated.
- Allow multiple bots to share memory search data and optionally shared documents.
- Add an administrator claim flow before any bot initialization or runtime configuration.

## Non-Goals

- Do not implement Codex, Claude Code, Kimi Code, or custom CLI providers in this iteration.
- Do not authenticate CLI providers through the LLM or Enterprise WeChat chat messages.
- Do not store real secrets, Kiro auth material, or claim codes in Git.
- Do not share Kiro chat sessions across bots.

## Runtime Model

The Docker host is the long-running deployment machine. It owns Docker, provider authentication, and the running containers.

```text
Docker host
  - Docker daemon
  - host-installed and logged-in provider CLI, currently kiro-cli
  - host provider auth/config directory
  - bot containers

Bot container
  - Node.js wecom-cli-bot runtime
  - provider CLI binary installed in the image
  - read-only mount of host provider auth/config
  - bot-local provider state/session directory
  - bot workspace

Memory service
  - shared ChromaDB and SQLite storage
  - shared namespace for cross-bot collaboration
```

For remote Docker deployments, the remote Docker host is still the machine that must have `kiro-cli` installed and logged in. The local operator machine does not provide provider auth.

## Provider Strategy

The code should retain a provider boundary, but current validation and scaffolding should only allow `kiro-cli`.

Current provider:

```yaml
cli:
  provider: kiro-cli
  command: kiro-cli
  args: ["chat", "--no-interactive", "--trust-all-tools", "{{prompt}}"]
  input_mode: arg
  prompt_placeholder: "{{prompt}}"
  stream_output: stdout
  stop_signal: SIGTERM
  kill_after_ms: 10000
  timeout_seconds: 10800
```

Future providers should fit the same adapter/auth shape, but should not be documented as available until implemented.

## Host Authentication Strategy

Provider authentication is completed on the Docker host before bot startup.

For `kiro-cli`:

1. The Docker host has `kiro-cli` installed.
2. The Docker host has completed Kiro login.
3. The bot container has `kiro-cli` installed in the image.
4. The host Kiro auth/config path is mounted into the container read-only.
5. Bot-local provider state is stored separately in the bot workspace or a Docker volume.

Authentication material must not be baked into the image. It must not be copied into `workspace/files`, `workspace/private`, prompt content, logs, or generated documents.

If Kiro CLI supports separate auth/config and session/cache directories, use that separation directly. If it only supports one home directory, the runtime should seed bot-local `KIRO_HOME` from the read-only host auth mount before startup, then keep mutable session state in the bot-local directory.

## Session Ownership

Kiro chat sessions belong to the bot runtime, not to shared memory and not to the host's global session history.

Session isolation:

- Bot A and Bot B do not share Kiro sessions.
- User A and User B inside the same bot do not share active sessions.
- `/history`, `/open`, `/new`, and `/name` operate on the current bot/user boundary.

This avoids cross-bot conversation pollution while still allowing collaboration through shared memory.

## Shared Knowledge Model

Memory and searchable document data are shared across bots by configuration.

Default recommendation:

```env
MEMORY_API_URL=http://memory-service:8000
MEMORY_NAMESPACE=team
```

All bots using the same namespace can:

- Store memory through `/remember`.
- Store fetched pages through `/fetch`.
- Store confirmed generated documents.
- Retrieve each other's stored knowledge during prompt building.

The first implementation should support a simple shared namespace model. A later iteration can add dual namespace search, such as `bot/<name>` plus `shared/team`.

## Shared Documents

Raw documents may also be shared through a Docker volume or host directory mounted into each bot container, for example:

```text
/shared/docs
```

When configured, confirmed generated documents should be saved to the shared document directory and indexed into memory. Without a shared document directory, bots can still collaborate through shared memory search data.

Document sharing is separate from Kiro session sharing.

## Administrator Claim Flow

Every bot must be claimed by an administrator before initialization.

The deployment-side CLI is responsible only for generating or resetting administrator claim codes. It does not edit soul files, instructions, provider auth, Kiro sessions, or memory data.

Suggested command shape:

```bash
npm run admin:claim -- --bot <bot-name>
npm run admin:claim -- --bot <bot-name> --reset
```

State file:

```text
bots/<bot-name>/workspace/private/admin.json
```

Suggested structure:

```json
{
  "admin_user_id": null,
  "status": "unclaimed",
  "claim": {
    "code_hash": "sha256:<hash>",
    "created_at": "2026-06-18T00:00:00.000Z",
    "expires_at": "2026-06-19T00:00:00.000Z",
    "used_at": null
  },
  "pending_transfer": null,
  "initialized_at": null
}
```

The CLI prints the plain claim code once:

```text
Send this message to the bot in Enterprise WeChat:
/claim_admin <code>
```

Only the hash is stored. The plain claim code is never stored in files, prompt content, or logs.

## Bot State Machine

The bot has three governance states:

```text
unclaimed
  No administrator exists.
  Only /claim_admin <code> is accepted.

initializing
  An administrator exists, but initialization has not completed.
  Only the administrator's messages are processed.
  Administrator messages continue the initialization guide.

ready
  Initialization has completed.
  Normal users can use the bot.
  Administrators can maintain runtime configuration.
```

Successful `/claim_admin <code>` behavior:

1. Verify the claim code hash and expiry.
2. Store the sender's Enterprise WeChat `userId` as `admin_user_id`.
3. Mark the claim code as used.
4. Set status to `initializing`.
5. Immediately start the initialization guide. The administrator does not need to send `/init`.

Initialization completion is detected when the generated `private/soul.md` no longer contains `[BOOTSTRAP]` and `instructions/AGENTS.md` has been written successfully. The runtime then sets status to `ready`.

## Administrator Permissions

Normal users may use normal chat and user-scoped session commands once the bot is ready.

Administrators additionally may:

- Re-run initialization.
- View and update `soul.md`.
- View and update `instructions/AGENTS.md`.
- Transfer administrator ownership.
- Reset initialization state if supported by a later command.

During `initializing`, non-admin messages receive a short rejection such as:

```text
机器人正在初始化，请稍后。
```

## Administrator Transfer

Administrator transfer should be explicit and accepted by the target user.

Flow:

```text
/transfer_admin <target-user-id>
  creates pending transfer

/accept_admin
  target user accepts before expiry
```

Optional command:

```text
/cancel_transfer_admin
```

If the administrator is lost, the deployment-side CLI can run with `--reset` to return the bot to `unclaimed` and generate a new claim code.

## Security Notes

- Do not inject `admin.json` into prompts.
- Do not expose claim code hashes to the LLM.
- Do not print provider auth files or token values in health checks.
- Keep provider auth outside workspace paths that users can scan or ask the model to inspect.
- If `--trust-all-tools` is used, prompt rules alone cannot prove that auth files are unreadable by tool execution. Mount provider auth read-only and outside the workspace, and keep sensitive paths blocked from scan/index workflows.

## Verification

Implementation should verify:

- Template typecheck passes.
- Only `kiro-cli` provider config is generated by the scaffold.
- Non-admin users cannot initialize or edit runtime configuration.
- A valid claim code promotes the sender to admin and starts initialization.
- Invalid, expired, or used claim codes are rejected.
- During initialization, only the admin can interact with the bot.
- Ready bots allow normal user chat while preserving admin-only configuration commands.
- Shared memory namespace allows one bot to retrieve knowledge stored by another bot.
