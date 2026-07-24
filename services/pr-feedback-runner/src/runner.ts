import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import type { FeedbackEvent, ProjectSession, ProjectSessionStore } from "./store.js";

const maxPayloadBytes = 1024 * 1024;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const projectPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const agentFeedbackMarker = "<!-- agentlattice:feedback -->";

export interface PrFeedbackRunnerConfig {
  store: ProjectSessionStore;
  internalToken: string;
  llmRunnerUrl: string;
  workspaceRoot: string;
  settingsFile?: string;
  webhookSecret?: string;
  executionTimeoutMs: number;
  now?: () => Date;
  fetch?: typeof fetch;
  onError?: (error: unknown) => void;
}

export function createPrFeedbackRunner(config: PrFeedbackRunnerConfig) {
  const now = config.now ?? (() => new Date());
  const fetchImpl = config.fetch ?? fetch;
  const activeProjectIds = new Set<string>();

  const dispatch = async (event: FeedbackEvent, session: ProjectSession): Promise<boolean> => {
    if (activeProjectIds.has(session.project_id)) return false;
    activeProjectIds.add(session.project_id);
    try {
      await resumeProject(config, session, event, fetchImpl);
    } catch (error) { config.onError?.(error); } finally { activeProjectIds.delete(session.project_id); }
    return true;
  };

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return Response.json({ service: "pr-feedback-runner", status: "ok", active: activeProjectIds.size > 0, active_project_count: activeProjectIds.size });
      if (request.method === "POST" && url.pathname === "/internal/project-sessions") {
        if (!hasInternalToken(request, config.internalToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const input = await request.json().catch(() => undefined);
        const session = parseProjectSession(input, config.workspaceRoot, now().toISOString());
        return Response.json({ session: await config.store.upsert(session) }, { status: 201 });
      }
      if (request.method === "GET" && url.pathname === "/internal/project-sessions") {
        if (!hasInternalToken(request, config.internalToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const session = await config.store.findByKey(
          readProjectId(url.searchParams.get("flow_id")),
          readText(url.searchParams.get("repository"), "repository"),
          readProjectId(url.searchParams.get("jira_key")),
        );
        return session ? Response.json({ session }) : Response.json({ error: "project session not found" }, { status: 404 });
      }
      const bind = url.pathname.match(/^\/internal\/project-sessions\/([^/]+)\/bind-pr$/);
      if (request.method === "POST" && bind) {
        if (!hasInternalToken(request, config.internalToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const body = await request.json().catch(() => undefined) as Record<string, unknown> | undefined;
        const repositoryId = readId(body?.repository_id, "repository_id");
        const prNumber = readPrNumber(body?.pr_number);
        const session = await config.store.bind(decodeURIComponent(bind[1]), repositoryId, prNumber, now().toISOString());
        return session ? Response.json({ session }) : Response.json({ error: "project session not found" }, { status: 404 });
      }
      const bindIssue = url.pathname.match(/^\/internal\/project-sessions\/([^/]+)\/bind-issue$/);
      if (request.method === "POST" && bindIssue) {
        if (!hasInternalToken(request, config.internalToken)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const body = await request.json().catch(() => undefined) as Record<string, unknown> | undefined;
        const repositoryId = readId(body?.repository_id, "repository_id");
        const issueNumber = readPrNumber(body?.issue_number);
        const session = await config.store.bindIssue(decodeURIComponent(bindIssue[1]), repositoryId, issueNumber, now().toISOString());
        return session ? Response.json({ session }) : Response.json({ error: "project session not found" }, { status: 404 });
      }
      if (request.method !== "POST" || url.pathname !== "/webhooks/github") return Response.json({ error: "not found" }, { status: 404 });
      const raw = await request.text();
      if (Buffer.byteLength(raw, "utf8") > maxPayloadBytes) return Response.json({ error: "payload is too large" }, { status: 413 });
      const webhookSecret = await loadWebhookSecret(config.settingsFile, config.webhookSecret);
      if (!hasValidGithubSignature(raw, request.headers.get("x-hub-signature-256"), webhookSecret)) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (request.headers.get("x-github-event") !== "issue_comment") return Response.json({ accepted: false, ignored: "event is not issue_comment" }, { status: 202 });
      const parsed = parseGithubComment(raw, request.headers.get("x-github-delivery"), now().toISOString());
      if (!parsed) return Response.json({ accepted: false, ignored: "not a human GitHub comment" }, { status: 202 });
      const session = parsed.target_type === "pull_request"
        ? await config.store.find(parsed.repository_id, parsed.target_number)
        : await config.store.findIssue(parsed.repository_id, parsed.target_number);
      if (!session) {
        return Response.json({ accepted: false, ignored: `${parsed.target_type} is not bound to a project session` }, { status: 202 });
      }
      if (activeProjectIds.has(session.project_id)) return Response.json({ accepted: false, delivery_id: parsed.delivery_id, status: "dropped_busy" }, { status: 202 });
      void dispatch(parsed, session);
      return Response.json({ accepted: true, delivery_id: parsed.delivery_id, status: "started" }, { status: 202 });
    },
    dispatch,
    status: () => ({ active: activeProjectIds.size > 0, active_project_count: activeProjectIds.size }),
  };
}

async function resumeProject(config: PrFeedbackRunnerConfig, session: ProjectSession, event: FeedbackEvent, fetchImpl: typeof fetch): Promise<void> {
  const targetLabel = event.target_type === "pull_request" ? `PR #${event.target_number}` : `Issue #${event.target_number}`;
  const runKind = event.target_type === "pull_request" ? "pr" : "issue";
  const runId = `${runKind}-${session.project_id}-${event.comment_id}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);
  const issuePromotionRule = event.target_type === "issue"
    ? `\n5. 此 Issue 是 Jira 测试准入阻塞项。必须基于本次补充重新输出测试准入结论；若为“测试准入：通过”，必须继续使用 easemob-qa-automation-project 创建/完善 repository/${session.jira_key}/ 自动化项目、执行真实测试并写入 reports/，不得只给用例草稿或停在分析。若仍不通过，明确最小缺失项与风险。`
    : "";
  const prompt = `你正在恢复 Project Agent Session，不是普通 Bot，也不与用户聊天。\n\n项目：${session.project_id}\nJira：${session.jira_key}\nGitHub ${targetLabel}\n分支：${session.branch}\n\n当前 GitHub ${targetLabel} 评论：\n${event.comment_body}\n\n规则：\n1. 这是同一持久工作目录和同一 CLI 对话的后续回合；先阅读当前 repository/ 代码与已有报告。\n2. 仅处理该评论明确要求的事项；若范围不明确，写出澄清问题到 feedback/ 报告，禁止猜测。\n3. 本地验证阶段允许修改 repository/${session.jira_key}/ 并执行测试，但不得 push、创建 PR 或调用 GitHub API。\n4. 将本轮结论写入 feedback/${event.target_type}-${event.target_number}-${event.comment_id}.md，包含评论、修改、测试结果及待办。${issuePromotionRule}`;
  const dispatcher = config.fetch ? undefined : new Agent({ headersTimeout: config.executionTimeoutMs + 30_000, bodyTimeout: config.executionTimeoutMs + 30_000 });
  try {
    const endpoint = `${config.llmRunnerUrl.replace(/\/+$/, "")}/v1/system-runs`;
    const body = JSON.stringify({ flow_id: session.flow_id, run_id: runId, workspace_id: session.workspace_id, runtime: session.runtime, prompt, provider_session_id: session.provider_session_id, runtime_env: await loadRuntimeEnv(config.settingsFile), auto_execute: true });
    const request = new Request(endpoint, { method: "POST", headers: internalHeaders(config.internalToken), body, signal: AbortSignal.timeout(config.executionTimeoutMs) });
    const response = config.fetch ? await fetchImpl(request) : await undiciFetch(endpoint, { method: "POST", headers: internalHeaders(config.internalToken), body, signal: AbortSignal.timeout(config.executionTimeoutMs), dispatcher });
    if (!response.ok) throw new Error(`CLI resume failed (${response.status}): ${await response.text()}`);
    const result = await response.json() as { output?: unknown; provider_session_id?: unknown };
    const reportDir = join(session.workspace_root, "feedback");
    await mkdir(reportDir, { recursive: true, mode: 0o700 });
    const output = String(result.output ?? "CLI completed");
    const reportName = `${event.target_type}-${event.target_number}-${event.comment_id}.md`;
    await writeFile(join(reportDir, reportName), `# GitHub ${targetLabel} Feedback\n\nComment: ${event.comment_body}\n\n## Agent output\n\n${output}\n`, { mode: 0o600 });
    const publication = event.target_type === "issue"
      ? await promoteUnblockedIssue(config, session, event, output, fetchImpl)
      : await publishPullRequestFeedback(config, session);
    await postGitHubFeedback(config, session, event, output, reportName, publication, fetchImpl);
    if (typeof result.provider_session_id === "string" && sessionPattern.test(result.provider_session_id)) {
      await config.store.upsert({ ...session, provider_session_id: result.provider_session_id, updated_at: new Date().toISOString() });
    }
  } finally { await dispatcher?.close().catch(() => {}); }
}

function parseProjectSession(value: unknown, workspaceRoot: string, timestamp: string): ProjectSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("project session must be an object");
  const input = value as Record<string, unknown>;
  const workspaceRootPath = resolve(workspaceRoot);
  const workspacePath = resolve(readText(input.workspace_root, "workspace_root"));
  if (relative(workspaceRootPath, workspacePath).startsWith("..")) throw new Error("workspace_root is outside the system Flow workspace");
  const runtime = input.runtime;
  if (runtime !== "kiro" && runtime !== "claude-code" && runtime !== "mock") throw new Error("runtime is invalid");
  const providerSessionId = typeof input.provider_session_id === "string" ? input.provider_session_id : undefined;
  if (providerSessionId && !sessionPattern.test(providerSessionId)) throw new Error("provider_session_id is invalid");
  return {
    project_id: readProjectId(input.project_id), jira_key: readProjectId(input.jira_key), flow_id: readProjectId(input.flow_id), workspace_id: readProjectId(input.workspace_id),
    workspace_root: workspacePath, repository: readText(input.repository, "repository"), branch: readText(input.branch, "branch"), runtime,
    ...(providerSessionId ? { provider_session_id: providerSessionId } : {}), head_sha: readText(input.head_sha, "head_sha"), updated_at: timestamp,
  };
}

async function loadRuntimeEnv(settingsFile?: string): Promise<Record<string, string>> {
  if (!settingsFile) return {};
  try {
    const settings = JSON.parse(await readFile(settingsFile, "utf8")) as { runtime_env?: unknown };
    if (typeof settings.runtime_env !== "string") return {};
    const result: Record<string, string> = {};
    for (const [index, source] of settings.runtime_env.replace(/\r\n/g, "\n").split("\n").entries()) {
      const line = source.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]{0,127})=(.*)$/);
      if (!match) throw new Error(`runtime .env line ${index + 1} is invalid`);
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (value) result[match[1]] = value;
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function loadWebhookSecret(settingsFile: string | undefined, fallback: string | undefined): Promise<string | undefined> {
  if (!settingsFile) return fallback;
  try {
    const settings = JSON.parse(await readFile(settingsFile, "utf8")) as { github_webhook_secret?: unknown };
    return typeof settings.github_webhook_secret === "string" && settings.github_webhook_secret.trim()
      ? settings.github_webhook_secret
      : fallback;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function postGitHubFeedback(
  config: PrFeedbackRunnerConfig,
  session: ProjectSession,
  event: FeedbackEvent,
  output: string,
  reportName: string,
  publication: GitHubPublication | undefined,
  fetchImpl: typeof fetch,
): Promise<void> {
  const token = await loadGitHubToken(config.settingsFile);
  if (!token) return;
  const repository = parseGitHubRepository(session.repository);
  const pullRequest = publication?.pull_request ? `\n\n已创建/更新自动化测试 PR：${publication.pull_request.html_url}` : "";
  const pushed = event.target_type === "pull_request" && publication?.pushed
    ? "\n\n本轮已验证的变更已提交并推送到当前 PR 分支。"
    : "";
  const body = `${agentFeedbackMarker}\n## AgentLattice QA Agent 回复\n\n已处理 GitHub ${event.target_type === "issue" ? "Issue" : "PR"} #${event.target_number} 的补充信息。${pullRequest}${pushed}\n\n${redactGitHubFeedback(output)}\n\n---\n本地完整报告：\`${reportName}\``;
  const response = await fetchImpl(new Request(`https://api.github.com/repos/${repository.owner}/${repository.name}/issues/${event.target_number}/comments`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "AgentLattice-Jira-Flow",
    },
    body: JSON.stringify({ body }),
  }));
  if (!response.ok) throw new Error(`GitHub feedback comment failed (${response.status}): ${await response.text()}`);
}

interface GitHubFlowSettings { github_token?: string; repository_branch?: string; auto_publish?: boolean; }
interface GitHubPullRequest { number: number; html_url: string; }
interface GitHubPublication { pull_request?: GitHubPullRequest; pushed?: boolean; }

async function promoteUnblockedIssue(
  config: PrFeedbackRunnerConfig,
  session: ProjectSession,
  event: FeedbackEvent,
  output: string,
  fetchImpl: typeof fetch,
): Promise<GitHubPublication | undefined> {
  if (!isReadinessApproved(output)) return undefined;
  const settings = await loadGitHubFlowSettings(config.settingsFile);
  if (!settings.auto_publish) return undefined;
  if (!settings.github_token) throw new Error("GITHUB_TOKEN is required to publish an unblocked Jira Flow Issue");
  const repositoryRoot = join(session.workspace_root, "repository");
  const reports = await readdir(join(repositoryRoot, session.jira_key, "reports"), { withFileTypes: true }).catch(() => []);
  if (!reports.some((entry) => entry.isFile() && entry.name.endsWith(".md"))) {
    throw new Error(`cannot publish ${session.jira_key}: no current Run Markdown report was created`);
  }
  await git(["-C", repositoryRoot, "add", "--", session.jira_key], settings.github_token);
  if (!await gitSucceeds(["-C", repositoryRoot, "diff", "--cached", "--quiet"], settings.github_token)) {
    await git(["-C", repositoryRoot, "-c", "user.name=AgentLattice Jira Flow", "-c", "user.email=agentlattice-jira-flow@localhost", "commit", "-m", `test(${session.jira_key}): resolve QA blocked Issue`], settings.github_token);
    await git(["-C", repositoryRoot, "push", "origin", `HEAD:refs/heads/${session.branch}`], settings.github_token);
  }
  const pullRequest = await ensureGitHubPullRequest(session, event, settings, fetchImpl);
  await config.store.bind(session.project_id, event.repository_id, pullRequest.number, new Date().toISOString());
  return { pull_request: pullRequest, pushed: true };
}

async function publishPullRequestFeedback(
  config: PrFeedbackRunnerConfig,
  session: ProjectSession,
): Promise<GitHubPublication | undefined> {
  const settings = await loadGitHubFlowSettings(config.settingsFile);
  if (!settings.auto_publish) return undefined;
  if (!settings.github_token) throw new Error("GITHUB_TOKEN is required to publish Jira Flow PR feedback");

  const repositoryRoot = join(session.workspace_root, "repository");
  await git(["-C", repositoryRoot, "add", "--", session.jira_key], settings.github_token);
  if (await gitSucceeds(["-C", repositoryRoot, "diff", "--cached", "--quiet"], settings.github_token)) {
    return { pushed: false };
  }

  await git([
    "-C", repositoryRoot,
    "-c", "user.name=AgentLattice Jira Flow",
    "-c", "user.email=agentlattice-jira-flow@localhost",
    "commit", "-m", `test(${session.jira_key}): apply PR feedback`,
  ], settings.github_token);
  await git(["-C", repositoryRoot, "push", "origin", `HEAD:refs/heads/${session.branch}`], settings.github_token);
  return { pushed: true };
}

async function ensureGitHubPullRequest(
  session: ProjectSession,
  event: FeedbackEvent,
  settings: GitHubFlowSettings,
  fetchImpl: typeof fetch,
): Promise<GitHubPullRequest> {
  const token = settings.github_token!;
  const repository = parseGitHubRepository(session.repository);
  const headers = githubHeaders(token);
  const base = settings.repository_branch?.trim() || "main";
  const existingUrl = new URL(`https://api.github.com/repos/${repository.owner}/${repository.name}/pulls`);
  existingUrl.searchParams.set("state", "open");
  existingUrl.searchParams.set("head", `${repository.owner}:${session.branch}`);
  existingUrl.searchParams.set("base", base);
  const existingResponse = await fetchImpl(new Request(existingUrl, { headers }));
  if (!existingResponse.ok) throw new Error(`GitHub Pull Request lookup failed (${existingResponse.status}): ${await existingResponse.text()}`);
  const existing = await existingResponse.json() as Array<Partial<GitHubPullRequest>>;
  if (existing[0] && typeof existing[0].number === "number" && typeof existing[0].html_url === "string") return { number: existing[0].number, html_url: existing[0].html_url };
  const response = await fetchImpl(new Request(`https://api.github.com/repos/${repository.owner}/${repository.name}/pulls`, {
    method: "POST", headers,
    body: JSON.stringify({ title: `[${session.jira_key}] 自动化测试结果`, head: session.branch, base, body: `Jira: ${session.jira_key}\n\n由阻塞 Issue #${event.target_number} 补充信息后自动创建。` }),
  }));
  if (!response.ok) throw new Error(`GitHub Pull Request creation failed (${response.status}): ${await response.text()}`);
  const payload = await response.json() as Partial<GitHubPullRequest>;
  if (typeof payload.number !== "number" || typeof payload.html_url !== "string") throw new Error("GitHub Pull Request creation returned invalid payload");
  return { number: payload.number, html_url: payload.html_url };
}

async function loadGitHubToken(settingsFile?: string): Promise<string | undefined> {
  if (!settingsFile) return undefined;
  try {
    const settings = JSON.parse(await readFile(settingsFile, "utf8")) as { github_token?: unknown };
    return typeof settings.github_token === "string" && settings.github_token.trim() ? settings.github_token : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function loadGitHubFlowSettings(settingsFile?: string): Promise<GitHubFlowSettings> {
  if (!settingsFile) return {};
  try {
    const settings = JSON.parse(await readFile(settingsFile, "utf8")) as GitHubFlowSettings;
    return {
      github_token: typeof settings.github_token === "string" && settings.github_token.trim() ? settings.github_token : undefined,
      repository_branch: typeof settings.repository_branch === "string" ? settings.repository_branch : undefined,
      auto_publish: settings.auto_publish === true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function isReadinessApproved(output: string): boolean {
  const normalized = output.replace(/[\s*_`]/g, "");
  return normalized.includes("测试准入：通过") || normalized.includes("测试准入:通过");
}

function parseGitHubRepository(url: string): { owner: string; name: string } {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error("project session repository is not a GitHub HTTPS URL");
  return { owner: match[1], name: match[2] };
}

function githubHeaders(token: string): Record<string, string> {
  return { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "AgentLattice-Jira-Flow" };
}

async function git(args: string[], token: string): Promise<void> {
  await new Promise<void>((resolve, reject) => execFile("git", args, {
    env: { ...process.env, GITHUB_TOKEN: token, GIT_ASKPASS: "/usr/local/bin/git-askpass", GIT_TERMINAL_PROMPT: "0" },
  }, (error) => error ? reject(error) : resolve()));
}

async function gitSucceeds(args: string[], token: string): Promise<boolean> {
  return new Promise((resolve) => execFile("git", args, {
    env: { ...process.env, GITHUB_TOKEN: token, GIT_ASKPASS: "/usr/local/bin/git-askpass", GIT_TERMINAL_PROMPT: "0" },
  }, (error) => resolve(!error)));
}

function redactGitHubFeedback(output: string): string {
  const redacted = output
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY))\s*=\s*[^\s]+/g, "$1=***")
    .replace(/([?&](?:token|access_token|password)=)[^\s&#]+/gi, "$1***");
  const maxLength = 6_000;
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}\n\n> 回复过长，已截断；请查看本地完整报告。`;
}

function parseGithubComment(raw: string, delivery: string | null, receivedAt: string): FeedbackEvent | undefined {
  if (!delivery || !idPattern.test(delivery)) throw new Error("x-github-delivery is required");
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const issue = payload.issue as Record<string, unknown> | undefined;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const comment = payload.comment as Record<string, unknown> | undefined;
  const sender = payload.sender as Record<string, unknown> | undefined;
  if (sender?.type === "Bot" || !repository || !comment || !issue || typeof comment.body === "string" && comment.body.includes(agentFeedbackMarker)) return undefined;
  const targetType = issue.pull_request ? "pull_request" : "issue";
  return { delivery_id: delivery, event_type: "issue_comment", repository_id: readId(repository.id, "repository.id"), target_type: targetType, target_number: readPrNumber(issue.number), comment_id: readId(comment.id, "comment.id"), comment_body: readText(comment.body, "comment.body"), received_at: receivedAt, status: "pending" };
}

function hasValidGithubSignature(raw: string, signature: string | null, secret: string | undefined): boolean {
  if (!secret?.trim()) return true;
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
  const left = Buffer.from(expected); const right = Buffer.from(signature);
  return left.length === right.length && timingSafeEqual(left, right);
}
function hasInternalToken(request: Request, token: string): boolean { return Boolean(token) && request.headers.get("authorization") === `Bearer ${token}`; }
function internalHeaders(token: string): Record<string, string> { return { "content-type": "application/json", authorization: `Bearer ${token}` }; }
function readText(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`); return value.trim(); }
function readProjectId(value: unknown): string { const id = readText(value, "project_id"); if (!projectPattern.test(id)) throw new Error("project id is invalid"); return id; }
function readId(value: unknown, field: string): string { const id = String(value ?? "").trim(); if (!id || !idPattern.test(id)) throw new Error(`${field} is invalid`); return id; }
function readPrNumber(value: unknown): number { if (!Number.isInteger(value) || (value as number) < 1) throw new Error("pr_number is invalid"); return value as number; }
function describeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 4000) : "PR feedback failed"; }
