import { createServer } from "node:http";
import { createJiraAutomationRunner } from "./runner.js";

const port = positiveInteger(process.env.PORT, 8910);
const runner = createJiraAutomationRunner({
  internalToken: process.env.JIRA_AUTOMATION_INTERNAL_TOKEN ?? "",
  llmRunnerUrl: (process.env.LLM_RUNNER_URL ?? "http://llm-runner:8200").replace(/\/+$/, ""),
  enabled: process.env.JIRA_AUTOMATION_ENABLED === "true",
  repositoryUrl: process.env.JIRA_AUTOMATION_REPOSITORY_URL?.trim(), repositoryBranch: process.env.JIRA_AUTOMATION_REPOSITORY_BRANCH?.trim() || "main", githubToken: process.env.GITHUB_TOKEN?.trim(),
  workspaceRoot: process.env.JIRA_AUTOMATION_WORKSPACE_ROOT ?? "/kiro-workspaces", mirrorRoot: process.env.JIRA_AUTOMATION_MIRROR_ROOT ?? "/data/repositories",
  flowId: "jira-automation", runtime: (process.env.JIRA_AUTOMATION_RUNTIME === "kiro" || process.env.JIRA_AUTOMATION_RUNTIME === "mock") ? process.env.JIRA_AUTOMATION_RUNTIME : "claude-code",
  executionTimeoutMs: positiveInteger(process.env.JIRA_AUTOMATION_EXECUTION_TIMEOUT_MS, 910000),
  settingsFile: process.env.JIRA_AUTOMATION_SETTINGS_FILE,
  flowRunsFile: process.env.JIRA_AUTOMATION_RUNS_FILE,
  skillsRoot: process.env.JIRA_AUTOMATION_SKILLS_ROOT ?? "/automation-config/skills",
  runtimeEnv: process.env.JIRA_AUTOMATION_RUNTIME_ENV,
  prFeedbackUrl: process.env.PR_FEEDBACK_RUNNER_URL?.replace(/\/+$/, ""),
  onError(error) { console.error(error instanceof Error ? error.message : "jira automation error"); },
});
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "POST" && url.pathname === "/internal/events") {
    if (!hasInternalToken(req.headers.authorization, process.env.JIRA_AUTOMATION_INTERNAL_TOKEN)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let event: unknown;
    try { event = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "event body must be JSON" })); return; }
    if (!isAutomationEvent(event)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "event is invalid" }));
      return;
    }
    const result = await runner.dispatch(event);
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ service: "jira-automation-runner", status: "ok", ...runner.status() }));
});
server.listen(port, "0.0.0.0", () => { runner.start(); console.log(`jira-automation-runner listening on ${port}`); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { runner.stop(); server.close(() => process.exit(0)); });
function positiveInteger(value: string | undefined, fallback: number): number { if (!value) return fallback; const parsed = Number.parseInt(value, 10); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`expected positive integer: ${value}`); return parsed; }

function hasInternalToken(authorization: string | undefined, expected: string | undefined): boolean {
  const token = expected?.trim();
  return Boolean(token) && authorization?.replace(/^Bearer\s+/i, "") === token;
}

function isAutomationEvent(value: unknown): value is { event_id: string; issue_key: string; event_type: string; received_at: string; payload: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  const text = (field: string) => typeof event[field] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(event[field]);
  return text("event_id") && text("issue_key") && text("event_type") && typeof event.received_at === "string"
    && Boolean(event.payload) && typeof event.payload === "object" && !Array.isArray(event.payload);
}
