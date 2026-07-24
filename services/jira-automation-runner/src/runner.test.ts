import { describe, expect, it, vi } from "vitest";
import { createJiraAutomationRunner, isReadinessBlocked } from "./runner.js";

const base = {
  internalToken: "internal", llmRunnerUrl: "http://runner",
  repositoryBranch: "main", workspaceRoot: "/tmp/workspaces", mirrorRoot: "/tmp/mirrors",
  flowId: "jira-automation", runtime: "mock" as const,
  executionTimeoutMs: 1_000,
};

describe("jira automation runner", () => {
  it("recognizes blocked readiness from both the machine marker and prior Skill wording", () => {
    expect(isReadinessBlocked("QA_READINESS: BLOCK")).toBe(true);
    expect(isReadinessBlocked("### 提测准入结论：**block**")).toBe(true);
    expect(isReadinessBlocked("| 准入判断 | **不通过** |")).toBe(true);
    expect(isReadinessBlocked("QA_READINESS: PASS\n测试准入：通过")).toBe(false);
  });

  it("does not start a Jira event until the flow is explicitly enabled", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const runner = createJiraAutomationRunner({ ...base, enabled: false, fetch });
    const result = await runner.dispatch({ event_id: "event-1", issue_key: "HIM-22187", event_type: "jira:issue_created", received_at: new Date().toISOString(), payload: {} });
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toEqual({ accepted: false, reason: "disabled" });
    expect(runner.status()).toMatchObject({ enabled: false, active: false });
  });
});
