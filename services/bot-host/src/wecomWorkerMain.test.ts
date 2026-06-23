import { afterEach, describe, expect, it, vi } from "vitest";

const sync = vi.fn(async () => undefined);
const start = vi.fn(() => Promise.resolve());
const restartInitialization = vi.fn();

vi.mock("./server.js", () => ({
  createBotHostSupervisor: vi.fn(() => ({
    start,
    sync,
    restartInitialization,
  })),
}));

vi.mock("./wecomClient.js", () => ({
  WeComLongConnectionClient: vi.fn(),
}));

describe("wecom worker entrypoint", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("serves only worker health and runtime sync endpoints", async () => {
    const { createWeComWorkerApp } = await import("./wecomWorkerMain.js");

    const { app } = createWeComWorkerApp();

    const health = await app.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      service: "wecom-worker",
      status: "ok",
    });

    const syncResponse = await app.fetch(new Request("http://localhost/internal/wecom-runtime/sync", {
      method: "POST",
    }));
    expect(syncResponse.status).toBe(200);
    expect(await syncResponse.json()).toEqual({ synced: true });
    expect(sync).toHaveBeenCalledTimes(1);

    const apiRoute = await app.fetch(new Request("http://localhost/v1/messages/wecom", {
      method: "POST",
      body: JSON.stringify({
        bot_id: "prd-bot",
        wecom_user_id: "user-a",
        text: "hello",
        runtime: "mock",
      }),
      headers: {
        "content-type": "application/json",
      },
    }));
    expect(apiRoute.status).toBe(404);
    expect(await apiRoute.json()).toEqual({ error: "not found" });
  });
});
