# WeCom CLI Bot Governance and Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved governance/provider design for `wecom-cli-bot`: current runtime support for `kiro-cli`, host-based CLI auth, shared knowledge configuration, and administrator claim/initialization control.

**Architecture:** Keep a provider boundary but ship only the Kiro adapter/config path now. Add a focused governance layer (`AdminStore`) that owns admin state, claim-code validation, initialization status, and transfer state, then route privileged BotWorker commands through it. Add a narrow deployment-side CLI that only creates or resets admin claim codes.

**Tech Stack:** Node.js 22, TypeScript ESM, `node:test`, `tsx`, Docker Compose, YAML config, existing WeCom runtime template.

---

## File Map

- Create `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/admin/adminStore.ts`: persistent admin state, claim-code hashing, transitions, transfer helpers.
- Create `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/admin/adminStore.test.ts`: focused unit tests for claim, reset, initialization, and transfer state.
- Create `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/scripts/admin-claim.ts`: deployment-side CLI for claim-code generation and reset.
- Create `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/scripts/admin-claim.test.ts`: CLI behavior tests using temporary bot workspaces.
- Modify `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/package.json`: add `test` script in Task 1; add `admin:claim` script in Task 3 after the CLI exists.
- Verify `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/tsconfig.json`: keep production `rootDir` and `include` unchanged so tests do not enter the runtime build.
- Modify `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/types.ts`: remove Kimi session type fields, keep provider string extensible, add optional shared document config.
- Modify `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/history/sessionStore.ts`: remove Kimi-specific session state.
- Modify `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/cli-adapters/cliRunner.ts`: preserve provider boundary but validate only `kiro-cli`; remove Kimi parsing/resume behavior.
- Modify `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/runtime/botWorker.ts`: add governance gates, `/claim_admin`, `/transfer_admin`, `/accept_admin`, `/cancel_transfer_admin`, admin-only init/config commands, and initialization lock.
- Modify `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/runtime/promptBuilder.ts`: add explicit sensitive-path guidance while keeping private admin state out of prompt.
- Modify `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/memory/memoryClient.ts`: honor `memory.enabled` in addition to API URL.
- Modify `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/bots/example-bot/workspace/private/bot.config.yaml`: Kiro-only default config, shared memory namespace example, optional shared docs config.
- Modify `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/bots/example-bot/workspace/private/.env.example`: Kiro host auth and shared memory placeholders.
- Modify `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/docker-compose.yml`: Kiro-only service example, host auth read-only mount, shared docs volume.
- Modify `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/Dockerfile`: remove Codex/Claude/Kimi install args, keep Kiro install arg.
- Modify `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/scripts/check-runtime.sh`: check only Kiro provider and avoid printing auth material.
- Modify `.agents/skills/wecom-cli-bot/SKILL.md`, `.agents/skills/wecom-cli-bot/references/cli-adapters.md`, `.agents/skills/wecom-cli-bot/references/runtime-installation.md`, `.agents/skills/wecom-cli-bot/references/security.md`, and `README.md`: document current Kiro-only support, host-auth model, admin claim flow, shared knowledge model.

## Task 1: Add Test Harness

**Files:**
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/package.json`
- Verify unchanged: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/tsconfig.json`

- [ ] **Step 1: Add a failing test script expectation**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm test
```

Expected: FAIL because `package.json` has no `test` script.

- [ ] **Step 2: Add test scripts**

Patch `package.json` scripts to include:

```json
{
  "scripts": {
    "dev": "tsx src/main.ts",
    "start": "node dist/main.js",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "node --test --import tsx \"src/**/*.test.ts\" \"scripts/**/*.test.ts\"",
    "bot:start": "tsx src/main.ts --bot"
  }
}
```

Keep all existing dependency versions unchanged.

- [ ] **Step 3: Keep production typecheck scoped to runtime**

Leave `tsconfig.json` `rootDir` as `src` and `include` as `["src/**/*.ts"]` for production build. Tests will run through `tsx` and do not need to be included in `tsc -p`.

- [ ] **Step 4: Verify empty test suite behavior**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm test
```

Expected: PASS with zero tests or no matching tests accepted by `node --test`. If the glob shell does not expand and Node errors on missing files, create a placeholder `src/smoke.test.ts` with:

```ts
import test from "node:test";
import assert from "node:assert/strict";

test("test harness runs", () => {
  assert.equal(1, 1);
});
```

- [ ] **Step 5: Commit**

```bash
git add .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/package.json .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/smoke.test.ts
git commit -m "test: add wecom bot template test harness"
```

If `src/smoke.test.ts` was not needed, omit it from `git add`.

## Task 2: Implement AdminStore

**Files:**
- Create: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/admin/adminStore.ts`
- Create: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/admin/adminStore.test.ts`

- [ ] **Step 1: Write failing AdminStore tests**

Create `src/admin/adminStore.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AdminStore, hashClaimCode } from "./adminStore.js";

function tempPrivateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "admin-store-"));
}

test("verifyClaim promotes matching code and marks initialization", () => {
  const privateDir = tempPrivateDir();
  const store = new AdminStore(privateDir);
  store.writeClaim("ABCD-1234", new Date("2030-01-01T00:00:00.000Z"));

  const result = store.verifyClaim("wecom-user-1", "ABCD-1234", new Date("2026-01-01T00:00:00.000Z"));

  assert.equal(result, true);
  const state = store.read();
  assert.equal(state.admin_user_id, "wecom-user-1");
  assert.equal(state.status, "initializing");
  assert.equal(state.claim?.used_at !== null, true);
});

test("verifyClaim rejects expired or wrong codes without setting admin", () => {
  const privateDir = tempPrivateDir();
  const store = new AdminStore(privateDir);
  store.writeClaim("ABCD-1234", new Date("2026-01-01T00:00:00.000Z"));

  assert.equal(store.verifyClaim("wecom-user-1", "WRONG", new Date("2025-01-01T00:00:00.000Z")), false);
  assert.equal(store.verifyClaim("wecom-user-1", "ABCD-1234", new Date("2027-01-01T00:00:00.000Z")), false);
  assert.equal(store.read().admin_user_id, null);
  assert.equal(store.read().status, "unclaimed");
});

test("markReady records initialized_at and ready status", () => {
  const privateDir = tempPrivateDir();
  const store = new AdminStore(privateDir);
  store.writeClaim("ABCD-1234", new Date("2030-01-01T00:00:00.000Z"));
  store.verifyClaim("wecom-user-1", "ABCD-1234", new Date("2026-01-01T00:00:00.000Z"));

  store.markReady(new Date("2026-01-02T00:00:00.000Z"));

  const state = store.read();
  assert.equal(state.status, "ready");
  assert.equal(state.initialized_at, "2026-01-02T00:00:00.000Z");
});

test("transfer requires target acceptance before expiry", () => {
  const privateDir = tempPrivateDir();
  const store = new AdminStore(privateDir);
  store.writeClaim("ABCD-1234", new Date("2030-01-01T00:00:00.000Z"));
  store.verifyClaim("admin-user", "ABCD-1234", new Date("2026-01-01T00:00:00.000Z"));
  store.startTransfer("admin-user", "new-admin", new Date("2026-01-01T00:00:00.000Z"), 60);

  assert.equal(store.acceptTransfer("wrong-user", new Date("2026-01-01T00:00:10.000Z")), false);
  assert.equal(store.acceptTransfer("new-admin", new Date("2026-01-01T00:00:10.000Z")), true);
  assert.equal(store.read().admin_user_id, "new-admin");
  assert.equal(store.read().pending_transfer, null);
});

test("hashClaimCode is deterministic and does not equal the plain code", () => {
  assert.equal(hashClaimCode("CODE"), hashClaimCode("CODE"));
  assert.notEqual(hashClaimCode("CODE"), "CODE");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm test -- src/admin/adminStore.test.ts
```

Expected: FAIL because `src/admin/adminStore.ts` does not exist.

- [ ] **Step 3: Implement AdminStore**

Create `src/admin/adminStore.ts`:

```ts
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type AdminStatus = "unclaimed" | "initializing" | "ready";

export type ClaimState = {
  code_hash: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
};

export type PendingTransfer = {
  to_user_id: string;
  created_at: string;
  expires_at: string;
};

export type AdminState = {
  admin_user_id: string | null;
  status: AdminStatus;
  claim: ClaimState | null;
  pending_transfer: PendingTransfer | null;
  initialized_at: string | null;
};

export function hashClaimCode(code: string): string {
  return `sha256:${crypto.createHash("sha256").update(code, "utf8").digest("hex")}`;
}

export function generateClaimCode(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export class AdminStore {
  private filePath: string;

  constructor(private privateDir: string) {
    this.filePath = path.join(privateDir, "admin.json");
  }

  read(): AdminState {
    if (!fs.existsSync(this.filePath)) return defaultState();
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<AdminState>;
    return { ...defaultState(), ...parsed };
  }

  write(state: AdminState): void {
    fs.mkdirSync(this.privateDir, { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }

  writeClaim(code: string, expiresAt: Date): void {
    const state = this.read();
    state.claim = {
      code_hash: hashClaimCode(code),
      created_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
      used_at: null
    };
    this.write(state);
  }

  resetWithClaim(code: string, expiresAt: Date): void {
    this.write({
      admin_user_id: null,
      status: "unclaimed",
      claim: {
        code_hash: hashClaimCode(code),
        created_at: new Date().toISOString(),
        expires_at: expiresAt.toISOString(),
        used_at: null
      },
      pending_transfer: null,
      initialized_at: null
    });
  }

  verifyClaim(userId: string, code: string, now = new Date()): boolean {
    const state = this.read();
    if (state.admin_user_id || state.status !== "unclaimed" || !state.claim || state.claim.used_at) return false;
    if (now > new Date(state.claim.expires_at)) return false;
    if (state.claim.code_hash !== hashClaimCode(code)) return false;
    state.admin_user_id = userId;
    state.status = "initializing";
    state.claim.used_at = now.toISOString();
    this.write(state);
    return true;
  }

  isAdmin(userId: string): boolean {
    return this.read().admin_user_id === userId;
  }

  markReady(now = new Date()): void {
    const state = this.read();
    state.status = "ready";
    state.initialized_at = now.toISOString();
    this.write(state);
  }

  markInitializing(): void {
    const state = this.read();
    if (!state.admin_user_id) throw new Error("Cannot initialize before admin claim");
    state.status = "initializing";
    state.initialized_at = null;
    this.write(state);
  }

  startTransfer(fromUserId: string, toUserId: string, now = new Date(), ttlSeconds = 86400): boolean {
    const state = this.read();
    if (state.admin_user_id !== fromUserId) return false;
    state.pending_transfer = {
      to_user_id: toUserId,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString()
    };
    this.write(state);
    return true;
  }

  acceptTransfer(userId: string, now = new Date()): boolean {
    const state = this.read();
    const transfer = state.pending_transfer;
    if (!transfer || transfer.to_user_id !== userId || now > new Date(transfer.expires_at)) return false;
    state.admin_user_id = userId;
    state.pending_transfer = null;
    this.write(state);
    return true;
  }

  cancelTransfer(userId: string): boolean {
    const state = this.read();
    if (state.admin_user_id !== userId || !state.pending_transfer) return false;
    state.pending_transfer = null;
    this.write(state);
    return true;
  }
}

function defaultState(): AdminState {
  return {
    admin_user_id: null,
    status: "unclaimed",
    claim: null,
    pending_transfer: null,
    initialized_at: null
  };
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm test -- src/admin/adminStore.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/admin/adminStore.ts .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/admin/adminStore.test.ts
git commit -m "feat: add bot admin state store"
```

## Task 3: Add Admin Claim CLI

**Files:**
- Create: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/scripts/admin-claim.ts`
- Create: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/scripts/admin-claim.test.ts`
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/package.json`

- [ ] **Step 1: Write failing CLI tests**

Create `scripts/admin-claim.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAdminClaim } from "./admin-claim.js";

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "admin-claim-"));
  fs.mkdirSync(path.join(root, "bots", "demo", "workspace", "private"), { recursive: true });
  return root;
}

test("runAdminClaim creates a claim without storing the plain code", () => {
  const root = tempRoot();
  const output: string[] = [];

  const result = runAdminClaim(["--bot", "demo"], root, (line) => output.push(line));

  assert.equal(result.ok, true);
  assert.match(output.join("\n"), /\/claim_admin /);
  const stateText = fs.readFileSync(path.join(root, "bots", "demo", "workspace", "private", "admin.json"), "utf8");
  assert.doesNotMatch(stateText, new RegExp(result.code));
  assert.match(stateText, /sha256:/);
});

test("runAdminClaim refuses to overwrite an existing admin without reset", () => {
  const root = tempRoot();
  runAdminClaim(["--bot", "demo"], root, () => {});
  const adminPath = path.join(root, "bots", "demo", "workspace", "private", "admin.json");
  const state = JSON.parse(fs.readFileSync(adminPath, "utf8"));
  state.admin_user_id = "admin";
  state.status = "ready";
  fs.writeFileSync(adminPath, JSON.stringify(state));

  const result = runAdminClaim(["--bot", "demo"], root, () => {});

  assert.equal(result.ok, false);
  assert.equal(result.error, "Bot already has an administrator. Use --reset to generate a new claim code.");
});

test("runAdminClaim reset clears admin and creates a fresh claim", () => {
  const root = tempRoot();
  const first = runAdminClaim(["--bot", "demo"], root, () => {});
  const reset = runAdminClaim(["--bot", "demo", "--reset"], root, () => {});

  const state = JSON.parse(fs.readFileSync(path.join(root, "bots", "demo", "workspace", "private", "admin.json"), "utf8"));
  assert.equal(reset.ok, true);
  assert.notEqual(reset.code, first.code);
  assert.equal(state.admin_user_id, null);
  assert.equal(state.status, "unclaimed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm test -- scripts/admin-claim.test.ts
```

Expected: FAIL because `scripts/admin-claim.ts` does not exist.

- [ ] **Step 3: Implement CLI**

Create `scripts/admin-claim.ts`:

```ts
import path from "node:path";
import { AdminStore, generateClaimCode } from "../src/admin/adminStore.js";

export type AdminClaimResult = {
  ok: boolean;
  code: string;
  error?: string;
};

export function runAdminClaim(argv: string[], rootDir = process.cwd(), writeLine = console.log): AdminClaimResult {
  const bot = valueAfter(argv, "--bot");
  const reset = argv.includes("--reset");
  if (!bot) {
    return { ok: false, code: "", error: "Usage: npm run admin:claim -- --bot <bot-name> [--reset]" };
  }

  const privateDir = path.join(rootDir, "bots", bot, "workspace", "private");
  const store = new AdminStore(privateDir);
  const state = store.read();
  if (state.admin_user_id && !reset) {
    return { ok: false, code: "", error: "Bot already has an administrator. Use --reset to generate a new claim code." };
  }

  const code = generateClaimCode();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (reset) {
    store.resetWithClaim(code, expiresAt);
  } else {
    store.writeClaim(code, expiresAt);
  }

  writeLine(`Admin claim code generated for bot: ${bot}`);
  writeLine("Send this message to the bot in Enterprise WeChat:");
  writeLine(`/claim_admin ${code}`);
  writeLine(`Expires at: ${expiresAt.toISOString()}`);
  return { ok: true, code };
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runAdminClaim(process.argv.slice(2));
  if (!result.ok) {
    console.error(result.error);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Run CLI tests**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm test -- scripts/admin-claim.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add npm script**

Patch `package.json` scripts to include:

```json
{
  "scripts": {
    "admin:claim": "tsx scripts/admin-claim.ts"
  }
}
```

- [ ] **Step 6: Smoke test CLI**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm run admin:claim -- --bot example-bot
```

Expected: prints `/claim_admin <code>` and writes `bots/example-bot/workspace/private/admin.json`. Do not commit the generated `admin.json`; it is private runtime state.

- [ ] **Step 7: Commit**

```bash
git add .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/scripts/admin-claim.ts .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/scripts/admin-claim.test.ts .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/package.json
git commit -m "feat: add admin claim cli"
```

## Task 4: Gate BotWorker With Admin State

**Files:**
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/runtime/botWorker.ts`
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/types.ts`
- Test: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/admin/adminStore.test.ts`

- [ ] **Step 1: Add failing state transition tests for initialization lock**

Append to `src/admin/adminStore.test.ts`:

```ts
test("markInitializing requires an existing admin", () => {
  const privateDir = tempPrivateDir();
  const store = new AdminStore(privateDir);

  assert.throws(() => store.markInitializing(), /Cannot initialize before admin claim/);
});
```

- [ ] **Step 2: Run test to verify it passes or fails correctly**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm test -- src/admin/adminStore.test.ts
```

Expected: PASS if Task 2 already included the behavior; otherwise FAIL until `markInitializing` matches the expected error.

- [ ] **Step 3: Add BotWorker admin imports and field**

In `src/runtime/botWorker.ts`, add:

```ts
import { AdminStore } from "../admin/adminStore.js";
```

Add a class field:

```ts
private admin: AdminStore;
```

Initialize it in the constructor:

```ts
this.admin = new AdminStore(runtime.privateDir);
```

- [ ] **Step 4: Add governance gate at the top of handleMessage**

After `const text = message.text.trim();`, add:

```ts
const adminState = this.admin.read();
if (adminState.status === "unclaimed") {
  const claimMatch = text.match(/^\/claim_admin\s+(\S+)$/);
  if (!claimMatch) {
    await this.wecom.sendText(message.conversationId, "机器人尚未完成管理员认领。请由部署者提供认领码。");
    return;
  }
  const claimed = this.admin.verifyClaim(message.userId, claimMatch[1]);
  if (!claimed) {
    await this.wecom.sendText(message.conversationId, "管理员认领失败。");
    return;
  }
  await this.wecom.sendText(message.conversationId, "管理员认领成功，开始初始化。");
  await this.handleInit(message);
  return;
}

if (adminState.status === "initializing" && !this.admin.isAdmin(message.userId)) {
  await this.wecom.sendText(message.conversationId, "机器人正在初始化，请稍后。");
  return;
}
```

- [ ] **Step 5: Make init/config commands admin-only**

Before handling `/init`, `/soul`, `/set_soul`, `/transfer_admin`, `/accept_admin`, `/cancel_transfer_admin`, check admin permission:

```ts
private async requireAdmin(message: IncomingWeComMessage): Promise<boolean> {
  if (this.admin.isAdmin(message.userId)) return true;
  await this.wecom.sendText(message.conversationId, "该指令仅管理员可用。");
  return false;
}
```

Use it in handlers:

```ts
if (text === "/init" || text === "/reinit") {
  if (!(await this.requireAdmin(message))) return;
  await this.handleInit(message);
  return;
}
```

For `/soul` and `/set_soul`, require admin before calling existing handlers.

- [ ] **Step 6: Add transfer commands**

Add command routing:

```ts
const transferMatch = text.match(/^\/transfer_admin\s+(\S+)$/);
if (transferMatch) {
  if (!(await this.requireAdmin(message))) return;
  await this.handleTransferAdmin(message, transferMatch[1]);
  return;
}
if (text === "/accept_admin") { await this.handleAcceptAdmin(message); return; }
if (text === "/cancel_transfer_admin") {
  if (!(await this.requireAdmin(message))) return;
  await this.handleCancelTransferAdmin(message);
  return;
}
```

Add handlers:

```ts
private async handleTransferAdmin(message: IncomingWeComMessage, targetUserId: string): Promise<void> {
  const ok = this.admin.startTransfer(message.userId, targetUserId);
  await this.wecom.sendText(message.conversationId, ok ? `管理员转移已发起，请目标用户发送 /accept_admin。` : "管理员转移失败。");
}

private async handleAcceptAdmin(message: IncomingWeComMessage): Promise<void> {
  const ok = this.admin.acceptTransfer(message.userId);
  await this.wecom.sendText(message.conversationId, ok ? "管理员转移已完成。" : "没有可接受的管理员转移。");
}

private async handleCancelTransferAdmin(message: IncomingWeComMessage): Promise<void> {
  const ok = this.admin.cancelTransfer(message.userId);
  await this.wecom.sendText(message.conversationId, ok ? "管理员转移已取消。" : "没有可取消的管理员转移。");
}
```

- [ ] **Step 7: Mark ready when initialization documents are written**

In the document block write path inside `onChunk` and the unfinished-document write path inside `onDone`, after writing `private/soul.md` or `instructions/AGENTS.md`, call a helper:

```ts
private maybeMarkInitialized(): void {
  const soulPath = path.join(this.runtime.privateDir, "soul.md");
  const agentsPath = path.join(this.runtime.instructionsDir, "AGENTS.md");
  if (!fs.existsSync(soulPath) || !fs.existsSync(agentsPath)) return;
  const soul = fs.readFileSync(soulPath, "utf8");
  if (soul.includes("[BOOTSTRAP]")) return;
  const state = this.admin.read();
  if (state.status === "initializing") this.admin.markReady();
}
```

Call `this.maybeMarkInitialized();` after config document writes.

- [ ] **Step 8: Remove duplicate init blocker**

Remove the old check that rejects `/init` when `soul.md` exists without `[BOOTSTRAP]`. Admins should be allowed to re-run init.

- [ ] **Step 9: Run tests and typecheck**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm test
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 10: Commit**

```bash
git add .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/runtime/botWorker.ts .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/types.ts .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/admin/adminStore.test.ts
git commit -m "feat: gate bot initialization by admin claim"
```

## Task 5: Kiro-Only Current Provider Implementation

**Files:**
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/cli-adapters/cliRunner.ts`
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/history/sessionStore.ts`
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/types.ts`
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/bots/example-bot/workspace/private/bot.config.yaml`

- [ ] **Step 1: Add failing provider validation behavior**

Create or update a focused test `src/cli-adapters/cliRunner.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { assertSupportedProvider } from "./cliRunner.js";

test("assertSupportedProvider allows kiro-cli", () => {
  assert.doesNotThrow(() => assertSupportedProvider("kiro-cli"));
});

test("assertSupportedProvider rejects providers not implemented in this release", () => {
  assert.throws(() => assertSupportedProvider("codex"), /Only kiro-cli is implemented/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm test -- src/cli-adapters/cliRunner.test.ts
```

Expected: FAIL because `assertSupportedProvider` is not exported.

- [ ] **Step 3: Implement provider assertion and remove Kimi behavior**

In `src/cli-adapters/cliRunner.ts`, add:

```ts
export function assertSupportedProvider(provider: string): void {
  if (provider !== "kiro-cli") {
    throw new Error(`Only kiro-cli is implemented in this release. Received: ${provider}`);
  }
}
```

Call it at the start of `run()` and `listSessions()`:

```ts
assertSupportedProvider(this.runtime.config.cli.provider);
```

Remove:

- `parseKimiOutput`
- `extractFinalAnswer`
- `kimiSessionId` in result handling
- Kimi `-r` resume argument injection

Keep Kiro resume/list/name behavior.

- [ ] **Step 4: Update SessionStore**

In `src/history/sessionStore.ts`, remove `kimiSessionId` from `Session` and remove `setKimiSessionId()`.

- [ ] **Step 5: Update BotWorker result handling**

Remove:

```ts
if (result.kimiSessionId) this.sessions.setKimiSessionId(session, result.kimiSessionId);
```

Keep:

```ts
if (result.kiroSessionId) this.sessions.setKiroSessionId(session, result.kiroSessionId);
```

- [ ] **Step 6: Update example config to Kiro-only**

Replace `bots/example-bot/workspace/private/bot.config.yaml` CLI section with:

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
  env:
    KIRO_HOME: "./bots/example-bot/workspace/cli-home/kiro"
```

Do not include Codex, Claude, or Kimi commented examples.

- [ ] **Step 7: Run tests and typecheck**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/cli-adapters/cliRunner.ts .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/cli-adapters/cliRunner.test.ts .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/history/sessionStore.ts .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/runtime/botWorker.ts .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/types.ts .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/bots/example-bot/workspace/private/bot.config.yaml
git commit -m "feat: limit current provider support to kiro cli"
```

## Task 6: Host Auth, Docker, and Runtime Checks

**Files:**
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/Dockerfile`
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/docker-compose.yml`
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/scripts/check-runtime.sh`
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/bots/example-bot/workspace/private/.env.example`
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/.gitignore`

- [ ] **Step 1: Update Dockerfile**

Remove `INSTALL_CODEX_CLI`, `INSTALL_CLAUDE_CODE`, and `INSTALL_KIMI_CODE`. Keep:

```dockerfile
# Kiro CLI. Set to "curl -fsSL https://cli.kiro.dev/install | bash" when building a runnable Kiro bot image.
ARG INSTALL_KIRO_CLI=""
RUN if [ -n "$INSTALL_KIRO_CLI" ]; then sh -lc "$INSTALL_KIRO_CLI"; fi
```

- [ ] **Step 2: Update docker-compose**

Replace provider examples with a single Kiro service:

```yaml
services:
  example-bot:
    build:
      context: .
      args:
        INSTALL_KIRO_CLI: "curl -fsSL https://cli.kiro.dev/install | bash"
    command: ["--bot", "example-bot"]
    restart: unless-stopped
    environment:
      - KIRO_HOST_AUTH_DIR=/run/cli-auth/kiro
      - MEMORY_API_URL=http://memory-service:8000
      - MEMORY_NAMESPACE=team
    volumes:
      - ${KIRO_HOST_HOME:-~/.kiro}:/run/cli-auth/kiro:ro
      - shared-docs:/shared/docs

volumes:
  shared-docs:
```

If Compose interpolation does not support `~`, document that operators should set `KIRO_HOST_HOME` to an absolute path.

- [ ] **Step 3: Update `.env.example`**

Replace CLI comments with:

```env
WECOM_BOT_ID=
WECOM_BOT_SECRET=

# Absolute path on the Docker host that contains logged-in Kiro CLI auth/config.
KIRO_HOST_HOME=/home/your-user/.kiro

MEMORY_API_URL=http://memory-service:8000
MEMORY_NAMESPACE=team
```

- [ ] **Step 4: Update runtime check**

Change `scripts/check-runtime.sh` to reject non-Kiro providers:

```bash
if [ "${provider}" != "kiro-cli" ]; then
  echo "Unsupported provider in this release: ${provider}" >&2
  exit 1
fi
```

Check `kiro-cli --version` and optionally `kiro-cli chat --list-sessions`, but do not print auth files or token contents.

- [ ] **Step 5: Ignore admin state**

Add to `.gitignore`:

```gitignore
bots/*/workspace/private/admin.json
```

- [ ] **Step 6: Verify Compose syntax**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
docker compose config
```

Expected: PASS if Docker Compose is available. If sandbox or daemon access fails, rerun with approved escalation. If Docker is not available, document the blocker in final handoff.

- [ ] **Step 7: Run typecheck**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/Dockerfile .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/docker-compose.yml .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/scripts/check-runtime.sh .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/bots/example-bot/workspace/private/.env.example .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/.gitignore
git commit -m "feat: configure kiro host auth runtime"
```

## Task 7: Shared Memory and Document Configuration

**Files:**
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/types.ts`
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/config.ts`
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/memory/memoryClient.ts`
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/runtime/botWorker.ts`
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/bots/example-bot/workspace/private/bot.config.yaml`

- [ ] **Step 1: Add memory enabled test**

Create `src/memory/memoryClient.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryClient } from "./memoryClient.js";
import type { BotRuntime } from "../types.js";

function runtime(memoryEnabled: boolean): BotRuntime {
  return {
    botName: "demo",
    rootDir: "/tmp/demo",
    workspaceDir: "/tmp/demo/workspace",
    privateDir: "/tmp/demo/workspace/private",
    filesDir: "/tmp/demo/workspace/files",
    instructionsDir: "/tmp/demo/workspace/instructions",
    config: {
      bot: { name: "demo", session_idle_ttl_seconds: 1, stop_keyword: "/stop", thinking_message: "", busy_message: "" },
      wecom: { bot_id_env: "WECOM_BOT_ID", secret_env: "WECOM_BOT_SECRET" },
      cli: { provider: "kiro-cli", command: "kiro-cli", args: [], input_mode: "arg", stream_output: "stdout", stop_signal: "SIGTERM", kill_after_ms: 1, timeout_seconds: 1 },
      memory: { enabled: memoryEnabled, api_url_env: "MEMORY_API_URL", namespace_env: "MEMORY_NAMESPACE", auto_retrieve: true, auto_store: true, retrieve_limit: 5 }
    },
    env: {},
    secrets: []
  };
}

test("MemoryClient is disabled when config disables memory even if env URL exists", () => {
  process.env.MEMORY_API_URL = "http://memory-service:8000";
  assert.equal(new MemoryClient(runtime(false)).enabled, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm test -- src/memory/memoryClient.test.ts
```

Expected: FAIL because current `MemoryClient.enabled` ignores `memory.enabled`.

- [ ] **Step 3: Fix MemoryClient**

Update `MemoryClient` constructor and getter:

```ts
private configured: boolean;

constructor(runtime: BotRuntime) {
  const mem = runtime.config.memory;
  this.configured = mem?.enabled === true;
  const url = process.env[mem?.api_url_env ?? "MEMORY_API_URL"] ?? "";
  const ns = process.env[mem?.namespace_env ?? "MEMORY_NAMESPACE"] ?? "default";
  this.baseUrl = url.replace(/\/$/, "");
  this.namespace = ns;
}

get enabled(): boolean {
  return this.configured && !!this.baseUrl;
}
```

- [ ] **Step 4: Add shared docs config type**

In `src/types.ts`, add:

```ts
export type DocumentsConfig = {
  shared_dir?: string;
};
```

Add to `BotConfig`:

```ts
documents?: DocumentsConfig;
```

- [ ] **Step 5: Use shared docs on confirm**

In `handleConfirm`, replace:

```ts
const docsDir = path.join(this.runtime.filesDir, "docs");
```

with:

```ts
const configuredDocsDir = this.runtime.config.documents?.shared_dir;
const docsDir = configuredDocsDir
  ? path.resolve(configuredDocsDir)
  : path.join(this.runtime.filesDir, "docs");
```

If using a configured shared dir, ensure it does not point to known sensitive auth paths. Add a guard:

```ts
if (docsDir.includes("/run/cli-auth")) {
  await this.wecom.sendText(message.conversationId, "共享文档目录配置无效。");
  return;
}
```

- [ ] **Step 6: Update example bot config**

Add:

```yaml
memory:
  enabled: true
  api_url_env: MEMORY_API_URL
  namespace_env: MEMORY_NAMESPACE
  auto_retrieve: true
  auto_store: true
  retrieve_limit: 5

documents:
  shared_dir: /shared/docs
```

- [ ] **Step 7: Run tests and typecheck**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/types.ts .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/config.ts .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/memory/memoryClient.ts .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/memory/memoryClient.test.ts .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/runtime/botWorker.ts .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/bots/example-bot/workspace/private/bot.config.yaml
git commit -m "feat: support shared memory and documents"
```

## Task 8: Prompt Safety Guidance

**Files:**
- Modify: `.agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/runtime/promptBuilder.ts`

- [ ] **Step 1: Add prompt safety expectation**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
rg -n "/run/cli-auth|admin.json|Do not inspect CLI auth" src/runtime/promptBuilder.ts
```

Expected: FAIL/no matches before this task.

- [ ] **Step 2: Add sensitive path guidance**

In `src/runtime/promptBuilder.ts`, extend the `# Security Constraint` block with:

```ts
"Do not inspect, print, scan, summarize, copy, or modify CLI authentication paths such as `/run/cli-auth`, host-mounted provider auth directories, `.kiro`, or `admin.json`. These files are runtime credentials or governance state and are not user content.",
```

Keep `admin.json` out of prompt content. Do not read it in `promptBuilder`.

- [ ] **Step 3: Verify guidance exists**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
rg -n "/run/cli-auth|admin.json|provider auth" src/runtime/promptBuilder.ts
npm run typecheck
```

Expected: `rg` finds the new guidance and typecheck passes.

- [ ] **Step 4: Commit**

```bash
git add .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template/src/runtime/promptBuilder.ts
git commit -m "feat: add prompt guard for auth paths"
```

## Task 9: Documentation and Skill Updates

**Files:**
- Modify: `.agents/skills/wecom-cli-bot/SKILL.md`
- Modify: `.agents/skills/wecom-cli-bot/references/cli-adapters.md`
- Modify: `.agents/skills/wecom-cli-bot/references/runtime-installation.md`
- Modify: `.agents/skills/wecom-cli-bot/references/security.md`
- Modify: `README.md`

- [ ] **Step 1: Update SKILL.md current support**

State that the current implementation only ships `kiro-cli`, while preserving the provider adapter boundary for future providers. Remove wizard provider selection. Bot creation should default to `kiro-cli`.

- [ ] **Step 2: Document admin claim flow**

Add instructions:

```bash
npm run admin:claim -- --bot <bot-name>
```

Then send:

```text
/claim_admin <code>
```

Document that successful claim immediately starts initialization and no `/init` is needed for first setup.

- [ ] **Step 3: Document host auth**

Document that the Docker host must install and log in with `kiro-cli`, and that containers mount host Kiro auth/config read-only. Make clear that remote Docker hosts must be authenticated on the remote host itself.

- [ ] **Step 4: Document shared memory and docs**

Document default shared namespace:

```env
MEMORY_NAMESPACE=team
```

Document optional `/shared/docs` volume for raw document sharing.

- [ ] **Step 5: Remove stale provider claims**

Search:

```bash
rg -n "Codex|Claude|Kimi|custom|provider" .agents/skills/wecom-cli-bot README.md
```

For current implementation docs, remove or rephrase claims that those providers are currently supported. It is acceptable to say future providers can be added through the adapter/auth strategy.

- [ ] **Step 6: Commit docs**

```bash
git add .agents/skills/wecom-cli-bot/SKILL.md .agents/skills/wecom-cli-bot/references/cli-adapters.md .agents/skills/wecom-cli-bot/references/runtime-installation.md .agents/skills/wecom-cli-bot/references/security.md README.md
git commit -m "docs: document kiro host auth and admin claim flow"
```

## Task 10: Final Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run template tests**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm test
```

Expected: PASS.

- [ ] **Step 2: Run template typecheck**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run runtime config check**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
./scripts/check-runtime.sh example-bot
```

Expected: PASS only if `kiro-cli` is installed in the current environment. If it fails because `kiro-cli` is missing, record that as an environment prerequisite, not a template type failure.

- [ ] **Step 4: Run Docker Compose syntax check**

Run:

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
docker compose config
```

Expected: PASS if Docker Compose is available and `KIRO_HOST_HOME` is set or default path resolves. If unavailable, record the exact blocker.

- [ ] **Step 5: Confirm no private runtime state is staged**

Run:

```bash
git status --short
git diff --cached --name-only
```

Expected: no `admin.json`, `.env`, `history/`, `logs/`, or `cli-home/` staged.

- [ ] **Step 6: Commit final verification notes only if files changed**

If verification required small doc corrections, commit them:

```bash
git add <changed-doc-files>
git commit -m "docs: clarify wecom bot verification"
```

Otherwise do not create an empty commit.

## Self-Review

- Spec coverage: provider abstraction/current Kiro-only support is covered in Tasks 5, 6, and 9. Host auth is covered in Tasks 6, 8, and 9. Shared knowledge is covered in Task 7. Admin claim, initialization lock, and transfer are covered in Tasks 2, 3, and 4. Verification is covered in Task 10.
- Placeholder scan: no task uses TBD/TODO language. Every implementation step names concrete files, commands, and expected outcomes.
- Type consistency: `AdminState`, `AdminStore`, `DocumentsConfig`, and `assertSupportedProvider` names are defined before they are used in later tasks.
