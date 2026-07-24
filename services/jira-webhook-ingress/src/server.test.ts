import { describe, expect, it } from "vitest";
import { createJiraWebhookIngressServer } from "./server.js";

describe("jira webhook ingress", () => {
  it("forwards a Jira event directly to the automation runner", async () => {
    const requests: Request[] = [];
    const app = createJiraWebhookIngressServer({
      runnerUrl: "http://runner", internalToken: "internal",
      fetch: async (request) => { requests.push(request instanceof Request ? request : new Request(request)); return Response.json({ accepted: true }, { status: 202 }); },
    });
    const response = await app.fetch(new Request("http://localhost/webhooks/jira", {
      method: "POST",
      body: JSON.stringify({ webhookEvent: "jira:issue_created", timestamp: "1720000000000", issue: { key: "HIM-22187" } }),
    }));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ accepted: true, issue_key: "HIM-22187", status: "started" });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://runner/internal/events");
    expect(requests[0].headers.get("authorization")).toBe("Bearer internal");
    await expect(requests[0].json()).resolves.toMatchObject({ issue_key: "HIM-22187", event_type: "jira:issue_created" });
  });

  it("requires the configured forwarding secret", async () => {
    const app = createJiraWebhookIngressServer({ runnerUrl: "http://runner", internalToken: "internal", sharedSecret: "secret" });
    const response = await app.fetch(new Request("http://localhost/webhooks/jira", {
      method: "POST",
      body: JSON.stringify({ issue: { key: "HIM-22187" } }),
    }));
    expect(response.status).toBe(401);
  });

  it("acknowledges a busy runner without retaining the event", async () => {
    const app = createJiraWebhookIngressServer({
      runnerUrl: "http://runner", internalToken: "internal",
      fetch: async () => Response.json({ accepted: false, reason: "busy" }, { status: 202 }),
    });
    const response = await app.fetch(new Request("http://localhost/webhooks/jira", { method: "POST", body: JSON.stringify({ issue_key: "HIM-22187" }) }));
    await expect(response.json()).resolves.toMatchObject({ accepted: false, status: "dropped_busy" });
  });
});
