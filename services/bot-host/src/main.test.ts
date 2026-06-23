import { afterEach, describe, expect, it, vi } from "vitest";

const botApiStart = vi.fn();
const wecomWorkerStart = vi.fn();

vi.mock("node:http", () => ({
  createServer: vi.fn(() => ({
    listen: vi.fn(),
  })),
}));

vi.mock("./server.js", () => ({
  createBotHostServer: vi.fn(() => ({
    fetch: vi.fn(),
  })),
  createBotHostSupervisor: vi.fn(() => ({
    start: vi.fn(),
    sync: vi.fn(),
    restartInitialization: vi.fn(),
  })),
}));

vi.mock("./wecomClient.js", () => ({
  WeComLongConnectionClient: vi.fn(),
}));

vi.mock("./botApiMain.js", () => ({
  startBotApiMain: botApiStart,
}));

vi.mock("./wecomWorkerMain.js", () => ({
  startWeComWorkerMain: wecomWorkerStart,
}));

describe("bot-host main entrypoint", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("starts the api entrypoint by default", async () => {
    vi.stubEnv("BOT_HOST_MODE", undefined);

    await import("./main.js");

    expect(botApiStart).toHaveBeenCalledTimes(1);
    expect(wecomWorkerStart).not.toHaveBeenCalled();
  });

  it("starts the worker entrypoint when BOT_HOST_MODE=worker", async () => {
    vi.stubEnv("BOT_HOST_MODE", "worker");

    await import("./main.js");

    expect(wecomWorkerStart).toHaveBeenCalledTimes(1);
    expect(botApiStart).not.toHaveBeenCalled();
  });
});
