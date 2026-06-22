import { describe, expect, it } from "vitest";
import { createDataServiceServer } from "./server.js";

describe("data-service server", () => {
  it("responds to health checks", async () => {
    const server = createDataServiceServer();
    const response = await server.fetch(new Request("http://localhost/health"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: "data-service",
      status: "ok",
    });
  });

  it("creates bots and resolves conversations over HTTP", async () => {
    const server = createDataServiceServer();
    const createResponse = await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "kiro",
          wecom_bot_id: "wecom-bot-a",
          wecom_secret: "super-secret-value",
        }),
      }),
    );

    expect(createResponse.status).toBe(201);

    const resolveResponse = await server.fetch(
      new Request("http://localhost/v1/conversations/resolve", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          channel: "wecom_direct",
          purpose: "normal_chat",
        }),
      }),
    );

    expect(resolveResponse.status).toBe(200);
    const body = await resolveResponse.json();
    expect(body).toMatchObject({
      bot_id: "prd-bot",
      wecom_user_id: "user-a",
      purpose: "normal_chat",
    });
    expect(body.conversation_id).toMatch(/^conv_/);
  });

  it("gets bot records over HTTP", async () => {
    const server = createDataServiceServer();
    await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "kiro",
          wecom_bot_id: "wecom-bot-a",
          wecom_secret: "super-secret-value",
        }),
      }),
    );

    const response = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      bot_id: "prd-bot",
      name: "PRD Bot",
      runtime: "kiro",
      status: "draft",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret_configured: true,
    });
    expect(JSON.stringify(body)).not.toContain("super-secret-value");
  });

  it("lists internal wecom runtime bot configs with secrets", async () => {
    const server = createDataServiceServer();
    await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "kiro",
          wecom_bot_id: "wecom-bot-a",
          wecom_secret: "super-secret-value",
        }),
      }),
    );
    await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "missing-secret",
          name: "Missing Secret",
          runtime: "kiro",
          wecom_bot_id: "wecom-bot-b",
        }),
      }),
    );

    const publicResponse = await server.fetch(new Request("http://localhost/v1/bots"));
    await expect(publicResponse.text()).resolves.not.toContain("super-secret-value");

    const internalResponse = await server.fetch(
      new Request("http://localhost/internal/wecom-runtime/bots"),
    );

    expect(internalResponse.status).toBe(200);
    await expect(internalResponse.json()).resolves.toEqual([
      {
        bot_id: "prd-bot",
        runtime: "kiro",
        wecom_bot_id: "wecom-bot-a",
        wecom_secret: "super-secret-value",
      },
    ]);
  });

  it("lists redacted bot channels and runtime enablement", async () => {
    const server = createDataServiceServer();
    await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "kiro",
          wecom_bot_id: "wecom-bot-a",
          wecom_secret: "super-secret-value",
        }),
      }),
    );
    await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "missing-secret",
          name: "Missing Secret",
          runtime: "kiro",
          wecom_bot_id: "wecom-bot-b",
        }),
      }),
    );

    const response = await server.fetch(
      new Request("http://localhost/v1/bot-channels"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("super-secret-value");
    expect(body).toMatchObject([
      {
        channel_id: "wecom:prd-bot",
        bot_id: "prd-bot",
        channel_type: "wecom",
        display_name: "企业微信",
        wecom_bot_id: "wecom-bot-a",
        secret_configured: true,
        connection_status: "unchecked",
        runtime_enabled: true,
        runtime_status: "enabled",
      },
      {
        channel_id: "wecom:missing-secret",
        bot_id: "missing-secret",
        wecom_bot_id: "wecom-bot-b",
        secret_configured: false,
        runtime_enabled: false,
        runtime_status: "missing_secret",
      },
    ]);

    const scoped = await server.fetch(
      new Request("http://localhost/v1/bot-channels?bot_id=prd-bot"),
    );
    await expect(scoped.json()).resolves.toMatchObject([
      {
        bot_id: "prd-bot",
      },
    ]);
  });

  it("gets channel detail and deletes channel configuration without deleting bot", async () => {
    const server = createDataServiceServer();
    await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "kiro",
          wecom_bot_id: "wecom-bot-a",
          wecom_secret: "super-secret-value",
        }),
      }),
    );
    await server.fetch(
      new Request("http://localhost/v1/bot-config-documents", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          title: "soul",
          content: "bot soul",
        }),
      }),
    );

    const detailResponse = await server.fetch(
      new Request("http://localhost/v1/bot-channels/wecom:prd-bot"),
    );
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json();
    expect(JSON.stringify(detail)).not.toContain("super-secret-value");
    expect(detail).toMatchObject({
      channel: {
        bot_id: "prd-bot",
        runtime_enabled: true,
      },
      bot: {
        bot_id: "prd-bot",
        wecom_secret_configured: true,
      },
      memory_documents: [],
      config_documents: [
        {
          title: "soul",
          content: "bot soul",
        },
      ],
    });

    const deleteResponse = await server.fetch(
      new Request("http://localhost/v1/bot-channels/wecom:prd-bot", {
        method: "DELETE",
      }),
    );
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toMatchObject({
      bot_id: "prd-bot",
      runtime_enabled: false,
      runtime_status: "missing_bot_id",
      secret_configured: false,
    });

    const botResponse = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot"),
    );
    await expect(botResponse.json()).resolves.toMatchObject({
      bot_id: "prd-bot",
      wecom_secret_configured: false,
      wecom_connection_status: "unchecked",
    });
  });

  it("keeps soul and agents out of memory documents", async () => {
    const server = createDataServiceServer();
    await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "kiro",
        }),
      }),
    );

    const memoryResponse = await server.fetch(
      new Request("http://localhost/v1/memory-documents", {
        method: "POST",
        body: JSON.stringify({
          scope: "bot",
          owner_id: "prd-bot",
          title: "agents.md",
          content: "agent config",
        }),
      }),
    );
    expect(memoryResponse.status).toBe(400);

    const configResponse = await server.fetch(
      new Request("http://localhost/v1/bot-config-documents", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          title: "agents.md",
          content: "agent config",
        }),
      }),
    );
    expect(configResponse.status).toBe(201);

    const docsResponse = await server.fetch(
      new Request("http://localhost/v1/memory-documents/current?scope=bot&owner_id=prd-bot"),
    );
    await expect(docsResponse.json()).resolves.toEqual([]);

    const configDocsResponse = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/config-documents"),
    );
    await expect(configDocsResponse.json()).resolves.toMatchObject([
      {
        bot_id: "prd-bot",
        title: "agents.md",
        content: "agent config",
      },
    ]);
  });

  it("stores bot config documents as current editable config instead of versions", async () => {
    const server = createDataServiceServer();
    await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "kiro",
        }),
      }),
    );

    await server.fetch(
      new Request("http://localhost/v1/bot-config-documents", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          title: "agents.md",
          content: "first config",
        }),
      }),
    );
    const updateResponse = await server.fetch(
      new Request("http://localhost/v1/bot-config-documents", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          title: "instructions/AGENTS.md",
          content: "updated config",
        }),
      }),
    );

    expect(updateResponse.status).toBe(201);
    const updated = await updateResponse.json() as Record<string, unknown>;
    expect(updated).toMatchObject({
      bot_id: "prd-bot",
      title: "agents.md",
      content: "updated config",
    });
    expect(updated).not.toHaveProperty("version");

    const configDocsResponse = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/config-documents"),
    );
    await expect(configDocsResponse.json()).resolves.toMatchObject([
      {
        bot_id: "prd-bot",
        title: "agents.md",
        content: "updated config",
      },
    ]);
  });

  it("lists and updates bot records over HTTP", async () => {
    const server = createDataServiceServer();
    await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "kiro",
        }),
      }),
    );
    await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "ops-bot",
          name: "Ops Bot",
          runtime: "mock",
        }),
      }),
    );

    const listResponse = await server.fetch(
      new Request("http://localhost/v1/bots"),
    );

    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject([
      { bot_id: "prd-bot", name: "PRD Bot" },
      { bot_id: "ops-bot", name: "Ops Bot" },
    ]);

    const updateResponse = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot", {
        method: "PATCH",
        body: JSON.stringify({
          name: "PRD Assistant",
          runtime: "mock",
          status: "initializing",
        }),
      }),
    );

    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({
      bot_id: "prd-bot",
      name: "PRD Assistant",
      runtime: "mock",
      status: "initializing",
    });
  });

  it("tests wecom connection configuration over HTTP", async () => {
    const server = createDataServiceServer();
    await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "kiro",
          wecom_bot_id: "wecom-bot-a",
          wecom_secret: "super-secret-value",
        }),
      }),
    );

    const response = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/wecom/test", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      bot_id: "prd-bot",
      status: "configured",
      wecom_bot_id: "wecom-bot-a",
      wecom_secret_configured: true,
    });
    expect(JSON.stringify(body)).not.toContain("super-secret-value");
  });

  it("resolves message context with admin gate", async () => {
    const server = createDataServiceServer();
    await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "kiro",
        }),
      }),
    );

    const blocked = await server.fetch(
      new Request("http://localhost/v1/message-context/resolve", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          channel: "wecom_direct",
          purpose: "normal_chat",
        }),
      }),
    );

    expect(blocked.status).toBe(200);
    await expect(blocked.json()).resolves.toMatchObject({
      allowed: false,
      reason: "admin_unclaimed",
    });

    const claimResponse = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin/claims", {
        method: "POST",
      }),
    );
    const claim = await claimResponse.json() as { code: string };

    await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin/claim/verify", {
        method: "POST",
        body: JSON.stringify({ wecom_user_id: "admin-a", code: claim.code }),
      }),
    );
    await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/ready", {
        method: "POST",
      }),
    );

    const allowed = await server.fetch(
      new Request("http://localhost/v1/message-context/resolve", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          wecom_user_id: "user-a",
          channel: "wecom_direct",
          purpose: "normal_chat",
        }),
      }),
    );

    await expect(allowed.json()).resolves.toMatchObject({
      allowed: true,
      reason: "ready",
    });
  });

  it("gets and transfers admins over HTTP", async () => {
    const server = createDataServiceServer();
    await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "kiro",
        }),
      }),
    );
    const claimResponse = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin/claims", {
        method: "POST",
      }),
    );
    const claim = await claimResponse.json() as { code: string };
    await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin/claim/verify", {
        method: "POST",
        body: JSON.stringify({ wecom_user_id: "admin-a", code: claim.code }),
      }),
    );

    const adminResponse = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin"),
    );

    expect(adminResponse.status).toBe(200);
    await expect(adminResponse.json()).resolves.toMatchObject({
      bot_id: "prd-bot",
      wecom_user_id: "admin-a",
    });

    const transferResponse = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin/transfer", {
        method: "POST",
        body: JSON.stringify({
          current_wecom_user_id: "admin-a",
          new_wecom_user_id: "admin-b",
        }),
      }),
    );

    expect(transferResponse.status).toBe(200);
    await expect(transferResponse.json()).resolves.toMatchObject({
      bot_id: "prd-bot",
      wecom_user_id: "admin-b",
    });

    const rejectedResponse = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin/transfer", {
        method: "POST",
        body: JSON.stringify({
          current_wecom_user_id: "admin-a",
          new_wecom_user_id: "admin-c",
        }),
      }),
    );

    expect(rejectedResponse.status).toBe(400);
    await expect(rejectedResponse.json()).resolves.toEqual({
      error: "current admin does not match",
    });
  });

  it("resets admin claim and bot initialization state over HTTP", async () => {
    const server = createDataServiceServer();
    await server.fetch(
      new Request("http://localhost/v1/bots", {
        method: "POST",
        body: JSON.stringify({
          bot_id: "prd-bot",
          name: "PRD Bot",
          runtime: "kiro",
        }),
      }),
    );
    const claimResponse = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin/claims", {
        method: "POST",
      }),
    );
    const claim = await claimResponse.json() as { code: string };
    await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin/claim/verify", {
        method: "POST",
        body: JSON.stringify({ wecom_user_id: "admin-a", code: claim.code }),
      }),
    );
    await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/ready", {
        method: "POST",
      }),
    );

    const resetAdmin = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin/reset", {
        method: "POST",
      }),
    );
    expect(resetAdmin.status).toBe(201);
    const newClaim = await resetAdmin.json() as { code: string };
    expect(newClaim.code).toMatch(/^[0-9]{6}$/);
    const adminAfterReset = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/admin"),
    );
    expect(adminAfterReset.status).toBe(404);

    const resetBot = await server.fetch(
      new Request("http://localhost/v1/bots/prd-bot/reset", {
        method: "POST",
      }),
    );
    expect(resetBot.status).toBe(200);
    await expect(resetBot.json()).resolves.toMatchObject({
      bot_id: "prd-bot",
      status: "draft",
    });
  });

  it("upserts and lists memory document versions over HTTP", async () => {
    const server = createDataServiceServer();

    const firstResponse = await server.fetch(
      new Request("http://localhost/v1/memory-documents", {
        method: "POST",
        body: JSON.stringify({
          scope: "bot",
          owner_id: "prd-bot",
          title: "prd-guideline",
          content: "first version",
        }),
      }),
    );
    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json() as { memory_doc_id: string };

    const secondResponse = await server.fetch(
      new Request("http://localhost/v1/memory-documents", {
        method: "POST",
        body: JSON.stringify({
          memory_doc_id: first.memory_doc_id,
          scope: "bot",
          owner_id: "prd-bot",
          title: "prd-guideline",
          content: "second version",
        }),
      }),
    );
    expect(secondResponse.status).toBe(201);

    const versionsResponse = await server.fetch(
      new Request(
        `http://localhost/v1/memory-documents/${first.memory_doc_id}/versions`,
      ),
    );

    expect(versionsResponse.status).toBe(200);
    const versions = await versionsResponse.json() as Array<{ version: number }>;
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
  });

  it("lists current memory documents over HTTP", async () => {
    const server = createDataServiceServer();

    const firstResponse = await server.fetch(
      new Request("http://localhost/v1/memory-documents", {
        method: "POST",
        body: JSON.stringify({
          scope: "bot",
          owner_id: "prd-bot",
          title: "prd-guideline",
          content: "v1",
        }),
      }),
    );
    const first = await firstResponse.json() as { memory_doc_id: string };

    await server.fetch(
      new Request("http://localhost/v1/memory-documents", {
        method: "POST",
        body: JSON.stringify({
          memory_doc_id: first.memory_doc_id,
          scope: "bot",
          owner_id: "prd-bot",
          title: "prd-guideline",
          content: "v2",
        }),
      }),
    );
    await server.fetch(
      new Request("http://localhost/v1/memory-documents", {
        method: "POST",
        body: JSON.stringify({
          scope: "bot",
          owner_id: "other-bot",
          title: "prd-guideline",
          content: "other",
        }),
      }),
    );

    const currentResponse = await server.fetch(
      new Request(
        "http://localhost/v1/memory-documents/current?scope=bot&owner_id=prd-bot",
      ),
    );

    expect(currentResponse.status).toBe(200);
    await expect(currentResponse.json()).resolves.toMatchObject([
      {
        title: "prd-guideline",
        version: 2,
        content: "v2",
      },
    ]);
  });
});
