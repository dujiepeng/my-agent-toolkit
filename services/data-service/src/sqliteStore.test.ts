import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_CLAIM_TTL_MS } from "./store.js";
import { createSqliteDataStore } from "./sqliteStore.js";

describe("sqlite data store", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists bot admin and conversation records across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const claim = first.createAdminClaim("prd-bot");
    expect(new Date(claim.expires_at).getTime() - new Date(claim.created_at).getTime())
      .toBe(ADMIN_CLAIM_TTL_MS);
    first.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: claim.code,
    });
    first.markBotReady("prd-bot");
    const conversation = first.resolveConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.getBot("prd-bot")).toMatchObject({
      bot_id: "prd-bot",
      status: "ready",
    });
    expect(second.resolveConversation({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      channel: "wecom_direct",
      purpose: "normal_chat",
    })).toEqual(conversation);
    second.close?.();
  });

  it("persists listed and updated bot records across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    const prd = first.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret: "super-secret-value",
    });
    first.createBot({
      bot_id: "ops-bot",
      name: "Ops Bot",
      runtime: "mock",
    });
    const updated = first.updateBot("prd-bot", {
      name: "PRD Assistant",
      runtime: "mock",
      status: "initializing",
      wecom_bot_id: "wecom-bot-b",
      wecom_secret: "new-secret-value",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(updated.created_at).toBe(prd.created_at);
    expect(updated.updated_at).not.toBe(prd.updated_at);
    expect(second.getBot("prd-bot")).toEqual(updated);
    expect(second.getBot("prd-bot")).toMatchObject({
      wecom_bot_id: "wecom-bot-b",
      wecom_secret_configured: true,
    });
    expect(JSON.stringify(second.getBot("prd-bot"))).not.toContain("new-secret-value");
    expect(JSON.stringify(second.getBot("prd-bot"))).not.toContain("super-secret-value");
    expect(second.listBots()).toMatchObject([
      { bot_id: "prd-bot", name: "PRD Assistant" },
      { bot_id: "ops-bot", name: "Ops Bot" },
    ]);
    second.close?.();
  });

  it("rejects duplicate persisted wecom bot bindings", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const store = createSqliteDataStore(dbPath);
    store.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
    });

    expect(() => store.createBot({
      bot_id: "ops-bot",
      name: "Ops Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
    })).toThrow("wecom bot id already bound to bot: prd-bot");

    store.createBot({
      bot_id: "ops-bot",
      name: "Ops Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-b",
    });

    expect(() => store.updateBot("ops-bot", {
      wecom_bot_id: "wecom-bot-a",
    })).toThrow("wecom bot id already bound to bot: prd-bot");
    store.close?.();
  });

  it("tests persisted wecom connection configuration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret: "super-secret-value",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    const result = await second.testWeComConnection("prd-bot");

    expect(result).toMatchObject({
      bot_id: "prd-bot",
      status: "configured",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret_configured: true,
    });
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    second.close?.();
  });

  it("verifies persisted wecom credentials with an injected verifier", async () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const store = createSqliteDataStore(dbPath, {
      wecomVerifier: {
        async verify(input) {
          expect(input).toEqual({
            bot_id: "wecom-bot-a",
            secret: "super-secret-value",
          });
          return { verified: true };
        },
      },
    });
    store.createBot({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret: "super-secret-value",
    });

    await expect(store.testWeComConnection("prd-bot")).resolves.toMatchObject({
      bot_id: "prd-bot",
      status: "verified",
    });
    expect(store.getBot("prd-bot")).toMatchObject({
      wecom_connection_status: "verified",
    });
    store.close?.();
  });

  it("persists transferred admins across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    first.createBot({ bot_id: "prd-bot", name: "PRD Bot", runtime: "kiro" });
    const claim = first.createAdminClaim("prd-bot");
    first.verifyAdminClaim({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
      code: claim.code,
    });
    const transferred = first.transferAdmin({
      bot_id: "prd-bot",
      current_wecom_user_id: "admin-a",
      new_wecom_user_id: "admin-b",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.getAdmin("prd-bot")).toEqual(transferred);
    second.close?.();
  });

  it("persists memory document versions across store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");

    const first = createSqliteDataStore(dbPath);
    const initial = first.upsertMemoryDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "prd-guideline",
      content: "first version",
    });
    const updated = first.upsertMemoryDocument({
      memory_doc_id: initial.memory_doc_id,
      scope: "bot",
      owner_id: "prd-bot",
      title: "prd-guideline",
      content: "second version",
    });
    first.close?.();

    const second = createSqliteDataStore(dbPath);
    expect(second.listMemoryDocumentVersions(initial.memory_doc_id)).toEqual([
      initial,
      updated,
    ]);
    second.close?.();
  });

  it("lists current memory document versions for a scope owner", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-service-"));
    dirs.push(dir);
    const dbPath = join(dir, "data.db");
    const store = createSqliteDataStore(dbPath);

    const guideline = store.upsertMemoryDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "prd-guideline",
      content: "v1",
    });
    const currentGuideline = store.upsertMemoryDocument({
      memory_doc_id: guideline.memory_doc_id,
      scope: "bot",
      owner_id: "prd-bot",
      title: "prd-guideline",
      content: "v2",
    });
    const processDoc = store.upsertMemoryDocument({
      scope: "bot",
      owner_id: "prd-bot",
      title: "prd-process",
      content: "agent docs",
    });
    store.upsertMemoryDocument({
      scope: "shared",
      owner_id: "prd-bot",
      title: "shared",
      content: "not returned",
    });

    expect(store.listCurrentMemoryDocuments({
      scope: "bot",
      owner_id: "prd-bot",
    })).toEqual([currentGuideline, processDoc]);
    store.close?.();
  });
});
