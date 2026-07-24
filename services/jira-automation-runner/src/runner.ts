import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { FlowRunReporter } from "./flowRuns.js";

export interface AutomationEvent { event_id: string; issue_key: string; event_type: string; received_at: string; payload: Record<string, unknown>; }
export interface JiraAutomationRunnerConfig {
  internalToken: string; llmRunnerUrl: string; enabled: boolean;
  repositoryUrl?: string; repositoryBranch: string; githubToken?: string;
  workspaceRoot: string; mirrorRoot: string; flowId: string;
  runtime: "kiro" | "claude-code" | "mock"; executionTimeoutMs: number;
  settingsFile?: string;
  flowRunsFile?: string;
  skills?: string[];
  skillsRoot?: string;
  runtimeEnv?: string;
  autoExecute?: boolean;
  autoPublish?: boolean;
  prFeedbackUrl?: string;
  fetch?: typeof fetch; onError?: (error: unknown) => void;
}

export function createJiraAutomationRunner(config: JiraAutomationRunnerConfig) {
  const fetchImpl = config.fetch ?? fetch;
  let running = false;
  const activeJiraKeys = new Set<string>();
  const dispatch = async (event: AutomationEvent): Promise<{ accepted: boolean; reason?: "disabled" | "busy" }> => {
    const effective = await withSavedSettings(config);
    if (!effective.enabled) return { accepted: false, reason: "disabled" };
    const jiraKey = event.issue_key.toUpperCase();
    if (activeJiraKeys.has(jiraKey)) return { accepted: false, reason: "busy" };
    activeJiraKeys.add(jiraKey);
    const runId = flowRunId(event);
    const reporter = new FlowRunReporter(config.flowRunsFile);
    await reporter.start({
      run_id: runId, jira_key: event.issue_key, title: eventTitle(event), runtime: effective.runtime,
      workspace_id: `jira-${event.issue_key}`, branch: `bot/${event.issue_key}`,
    }).catch((error) => { config.onError?.(error); });
    void execute(effective, event, fetchImpl, reporter, runId)
      .catch(async (error) => {
        await reporter.finish(runId, "failed", "failed", "执行失败；请查看 Runner 日志。 ").catch(() => {});
        config.onError?.(error);
      })
      .finally(() => { activeJiraKeys.delete(jiraKey); });
    return { accepted: true };
  };
  return {
    start() { running = true; },
    stop() { running = false; },
    dispatch,
    status: () => ({ running, active: activeJiraKeys.size > 0, active_jira_count: activeJiraKeys.size, enabled: config.enabled }),
  };
}

async function withSavedSettings(config: JiraAutomationRunnerConfig): Promise<JiraAutomationRunnerConfig> {
  if (!config.settingsFile) return config;
  try {
    const saved = JSON.parse(await readFile(config.settingsFile, "utf8")) as Record<string, unknown>;
    return {
      ...config,
      enabled: typeof saved.enabled === "boolean" ? saved.enabled : config.enabled,
      repositoryUrl: typeof saved.repository_url === "string" && saved.repository_url.trim() ? saved.repository_url.trim() : config.repositoryUrl,
      repositoryBranch: typeof saved.repository_branch === "string" && saved.repository_branch.trim() ? saved.repository_branch.trim() : config.repositoryBranch,
      runtime: saved.runtime === "kiro" || saved.runtime === "claude-code" ? saved.runtime : config.runtime,
      skills: Array.isArray(saved.skills) ? saved.skills.filter((name): name is string => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) : config.skills,
      githubToken: typeof saved.github_token === "string" && saved.github_token ? saved.github_token : config.githubToken,
      runtimeEnv: typeof saved.runtime_env === "string" ? saved.runtime_env : config.runtimeEnv,
      autoExecute: saved.auto_execute === true,
      autoPublish: saved.auto_publish === true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return config;
    throw new Error("Jira Automation Flow settings are invalid");
  }
}

async function execute(config: JiraAutomationRunnerConfig, event: AutomationEvent, fetchImpl: typeof fetch, reporter: FlowRunReporter, runId: string): Promise<void> {
  let cliDispatcher: Agent | undefined;
  try {
    if (!config.repositoryUrl) throw new Error("JIRA_AUTOMATION_REPOSITORY_URL is not configured");
    const runtimeEnv = normalizeRuntimeEnv(parseRuntimeEnv(config.runtimeEnv));
    await reporter.step(runId, "workspace", "running", "正在准备独立项目工作目录");
    const workspace = await prepareWorkspace(config, event, runtimeEnv);
    await reporter.step(runId, "workspace", "succeeded", "独立项目工作目录已就绪");
    const existingSession = config.prFeedbackUrl ? await findProjectSession(config, event, fetchImpl) : undefined;
    const prompt = buildPrompt(event, config.autoExecute === true, Object.keys(runtimeEnv));
    const endpoint = `${config.llmRunnerUrl}/v1/system-runs`;
    const headers = { "content-type": "application/json", authorization: `Bearer ${config.internalToken}`, "x-trace-id": event.event_id };
    const body = JSON.stringify({ flow_id: config.flowId, run_id: workspace.runId, workspace_id: workspace.projectId, runtime: config.runtime, prompt, trace_id: event.event_id, runtime_env: runtimeEnv, auto_execute: config.autoExecute === true, ...(existingSession?.provider_session_id ? { provider_session_id: existingSession.provider_session_id } : {}) });
    const signal = AbortSignal.timeout(config.executionTimeoutMs);
    const request = new Request(endpoint, {
      method: "POST", headers, body, signal,
    });
    // Node's built-in fetch waits only about five minutes for the first response
    // header. A System Flow legitimately waits for the CLI's 15-minute run, so
    // give this internal request a little headroom while retaining the explicit
    // execution timeout above as the overall limit.
    cliDispatcher = config.fetch ? undefined : new Agent({
      headersTimeout: config.executionTimeoutMs + 30_000,
      bodyTimeout: config.executionTimeoutMs + 30_000,
    });
    await reporter.step(runId, "cli", "running", existingSession?.provider_session_id ? "正在恢复 CLI 会话" : "正在启动 CLI 分析与执行");
    const response = config.fetch
      ? await fetchImpl(request)
      : await undiciFetch(endpoint, { method: "POST", headers, body, signal, dispatcher: cliDispatcher });
    if (!response.ok) throw new Error(`CLI runner failed (${response.status}): ${await response.text()}`);
    const result = await response.json() as { output?: unknown; provider_session_id?: unknown };
    const output = String(result.output ?? "CLI completed");
    await writeFile(join(workspace.root, "automation-result.md"), output, { mode: 0o600 });
    await reporter.step(runId, "cli", "succeeded", "CLI 已完成本轮执行");
    if (isReadinessBlocked(output)) {
      if (!config.prFeedbackUrl) throw new Error("PR_FEEDBACK_RUNNER_URL is required to resume a blocked Jira Flow from a GitHub Issue comment");
      if (!config.githubToken) throw new Error("GITHUB_TOKEN with Issues: write is required to create a blocked Jira Flow Issue");
      await registerProjectSession(config, workspace, event, result, fetchImpl);
      const issue = existingSession?.issue_number
        ? existingBlockedGithubIssue(config, existingSession.issue_number)
        : await createBlockedGithubIssue(config, event, output, fetchImpl);
      if (!existingSession?.issue_number) await bindBlockedIssue(config, workspace.projectId, issue, fetchImpl);
      await writeFile(join(workspace.root, "github-issue.md"), `# Blocked GitHub Issue\n\nIssue: ${issue.html_url}\n\nNumber: ${issue.number}\n`, { mode: 0o600 });
      await reporter.finish(runId, "blocked", "waiting_feedback", "测试准入不通过，等待 GitHub Issue 补充信息", { issue_url: issue.html_url });
    } else {
      if (config.autoPublish) {
        await reporter.step(runId, "publish", "running", "正在提交当前 Jira 项目");
        await publishJiraProject(config, workspace.repository, event.issue_key);
      }
      if (config.prFeedbackUrl) await registerProjectSession(config, workspace, event, result, fetchImpl);
      let pullRequestUrl: string | undefined;
      if (config.autoPublish) {
        if (!config.prFeedbackUrl) throw new Error("PR_FEEDBACK_RUNNER_URL is required to bind an automatically created Pull Request");
        const pullRequest = await ensureGitHubPullRequest(config, event, fetchImpl);
        await bindPullRequest(config, workspace.projectId, pullRequest, fetchImpl);
        await writeFile(join(workspace.root, "pull-request.md"), `# GitHub Pull Request\n\nPR: ${pullRequest.html_url}\n\nNumber: ${pullRequest.number}\n`, { mode: 0o600 });
        pullRequestUrl = pullRequest.html_url;
        await reporter.step(runId, "publish", "succeeded", "当前 Jira 项目已提交并关联 Pull Request");
      }
      await reporter.finish(runId, "succeeded", "completed", "Jira 自动化任务已完成", { pull_request_url: pullRequestUrl, report_path: `${event.issue_key}/reports/` });
    }
  } catch (error) { throw new Error(describeError(error)); }
  finally {
    await cliDispatcher?.close().catch(() => {});
  }
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return "automation failed";
  const cause = error.cause;
  if (cause instanceof Error && cause.message) return `${error.message}: ${cause.message}`;
  if (typeof cause === "object" && cause && "code" in cause) return `${error.message}: ${String((cause as { code: unknown }).code)}`;
  return error.message;
}

async function prepareWorkspace(
  config: JiraAutomationRunnerConfig,
  event: AutomationEvent,
  runtimeEnv: Record<string, string>,
): Promise<{ root: string; runId: string; projectId: string; repository: string }> {
  const runId = flowRunId(event);
  const flowRoot = join(config.workspaceRoot, "system-flows", config.flowId);
  const projectId = `jira-${event.issue_key}`;
  const root = join(flowRoot, "projects", projectId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await installSkills(flowRoot, config.skills ?? [], config.skillsRoot);
  const repository = join(root, "repository");
  const mirror = join(config.mirrorRoot, `${shortHash(config.repositoryUrl!)}.git`);
  await mkdir(config.mirrorRoot, { recursive: true, mode: 0o700 });
  let migratedProjectDirectory: string | undefined;
  if (existsSync(join(repository, ".git"))) {
    const currentRemote = await gitOutput(["-C", repository, "remote", "get-url", "origin"], config.githubToken);
    if (!sameRepositoryUrl(currentRemote, config.repositoryUrl!)) {
      // A Jira workspace is persistent, while its configured publication repository can
      // legitimately change. Do not let the old origin receive a later Jira result.
      // Preserve only this Jira's generated project; other repository content belongs to
      // the old target and must not be copied into the newly selected repository.
      const sourceProject = join(repository, event.issue_key);
      if (existsSync(sourceProject)) {
        migratedProjectDirectory = join(root, "migration-backups", `${event.issue_key}-${Date.now()}`);
        await mkdir(join(root, "migration-backups"), { recursive: true, mode: 0o700 });
        await cp(sourceProject, migratedProjectDirectory, { recursive: true, force: true });
      }
      await rm(repository, { recursive: true, force: true });
    }
  }
  if (existsSync(mirror)) await git(["--git-dir", mirror, "fetch", "--prune", "origin"], config.githubToken);
  else await git(["clone", "--mirror", config.repositoryUrl!, mirror], config.githubToken);
  const branch = `bot/${event.issue_key}`;
  if (!existsSync(join(repository, ".git"))) {
    await git(["clone", "--reference-if-able", mirror, "--dissociate", "--branch", config.repositoryBranch, "--single-branch", config.repositoryUrl!, repository], config.githubToken);
    const hasRemoteBranch = await gitSucceeds(["-C", repository, "fetch", "origin", `${branch}:refs/remotes/origin/${branch}`], config.githubToken);
    await git(["-C", repository, "checkout", "-B", branch, hasRemoteBranch ? `origin/${branch}` : `origin/${config.repositoryBranch}`], config.githubToken);
  }
  if (migratedProjectDirectory) {
    await cp(migratedProjectDirectory, join(repository, event.issue_key), { recursive: true, force: true });
    await writeFile(
      join(root, "repository-migration.md"),
      `# Repository migration\n\n${event.issue_key} was moved to ${config.repositoryUrl} at ${new Date().toISOString()}.\n`,
      { mode: 0o600 },
    );
  }
  await mkdir(join(repository, event.issue_key, "reports"), { recursive: true, mode: 0o700 });
  await materializeRuntimeEnv(repository, event.issue_key, runtimeEnv);
  await writeFile(join(root, "RUN_CONTEXT.md"), `# ${event.issue_key}\n\nSource event: ${event.event_type}\nJira: ${eventUrl(event)}\n\nProject root: \`repository/${event.issue_key}/\`\nOnly modify this project directory.\n`, { mode: 0o600 });
  return { root, runId, projectId, repository };
}

function flowRunId(event: AutomationEvent): string { return `jira-${event.issue_key}-${shortHash(event.event_id)}`; }

function eventTitle(event: AutomationEvent): string {
  const title = event.payload.title ?? (event.payload.issue && typeof event.payload.issue === "object" && !Array.isArray(event.payload.issue) ? (event.payload.issue as Record<string, unknown>).summary : undefined);
  return typeof title === "string" && title.trim() ? title.trim().slice(0, 300) : event.issue_key;
}

async function registerProjectSession(
  config: JiraAutomationRunnerConfig,
  workspace: { root: string; runId: string; projectId: string; repository: string },
  event: AutomationEvent,
  result: { provider_session_id?: unknown },
  fetchImpl: typeof fetch,
): Promise<void> {
  const providerSessionId = typeof result.provider_session_id === "string" ? result.provider_session_id : undefined;
  if (!providerSessionId && config.runtime !== "mock") throw new Error("CLI did not return a provider session id");
  const response = await fetchImpl(new Request(`${config.prFeedbackUrl}/internal/project-sessions`, {
    method: "POST", headers: internalHeaders(config),
    body: JSON.stringify({
      project_id: workspace.projectId, jira_key: event.issue_key, flow_id: config.flowId,
      workspace_id: workspace.projectId, workspace_root: workspace.root, repository: config.repositoryUrl,
      branch: `bot/${event.issue_key}`, runtime: config.runtime, provider_session_id: providerSessionId,
      head_sha: await gitOutput(["-C", workspace.repository, "rev-parse", "HEAD"], config.githubToken),
    }),
  }));
  if (!response.ok) throw new Error(`project session registration failed (${response.status})`);
}

interface GitHubIssue { id: string; number: number; html_url: string; }
interface GitHubPullRequest { number: number; html_url: string; }

function existingBlockedGithubIssue(config: JiraAutomationRunnerConfig, issueNumber: number): GitHubIssue {
  const repository = parseGitHubRepository(config.repositoryUrl!);
  return {
    id: `existing-${issueNumber}`,
    number: issueNumber,
    html_url: `https://github.com/${repository.owner}/${repository.name}/issues/${issueNumber}`,
  };
}

async function createBlockedGithubIssue(
  config: JiraAutomationRunnerConfig,
  event: AutomationEvent,
  output: string,
  fetchImpl: typeof fetch,
): Promise<GitHubIssue> {
  const repository = parseGitHubRepository(config.repositoryUrl!);
  const body = [
    `Jira: ${eventUrl(event)}`,
    "",
    "## 自动化测试准入不通过",
    "",
    "该 Issue 由 Jira Automation Flow 自动创建。请在此补充缺失的需求、验收标准、接口定义、异常边界、权限、测试数据或环境信息；评论后会恢复同一个 QA Agent Session 重新评估。",
    "",
    "## QA 准入报告",
    "",
    truncateIssueBody(output),
  ].join("\n");
  const response = await fetchImpl(new Request(`https://api.github.com/repos/${repository.owner}/${repository.name}/issues`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${config.githubToken}`,
      "content-type": "application/json",
      "user-agent": "AgentLattice-Jira-Flow",
    },
    body: JSON.stringify({ title: `[QA Blocked][${event.issue_key}] 自动化测试准入不通过`, body }),
  }));
  if (!response.ok) throw new Error(`GitHub Issue creation failed (${response.status}): ${await response.text()}`);
  const payload = await response.json() as Partial<GitHubIssue>;
  const number = payload.number;
  if (typeof number !== "number" || !Number.isInteger(number) || typeof payload.id !== "number" && typeof payload.id !== "string" || typeof payload.html_url !== "string") {
    throw new Error("GitHub Issue creation returned invalid payload");
  }
  return { id: String(payload.id), number, html_url: payload.html_url };
}

async function bindBlockedIssue(
  config: JiraAutomationRunnerConfig,
  projectId: string,
  issue: GitHubIssue,
  fetchImpl: typeof fetch,
): Promise<void> {
  const repository = parseGitHubRepository(config.repositoryUrl!);
  const repositoryId = await getGitHubRepositoryId(config, repository, fetchImpl);
  const response = await fetchImpl(new Request(`${config.prFeedbackUrl}/internal/project-sessions/${encodeURIComponent(projectId)}/bind-issue`, {
    method: "POST", headers: internalHeaders(config), body: JSON.stringify({ repository_id: repositoryId, issue_number: issue.number }),
  }));
  if (!response.ok) throw new Error(`blocked GitHub Issue binding failed (${response.status})`);
}

async function ensureGitHubPullRequest(
  config: JiraAutomationRunnerConfig,
  event: AutomationEvent,
  fetchImpl: typeof fetch,
): Promise<GitHubPullRequest> {
  if (!config.githubToken) throw new Error("GITHUB_TOKEN with Pull requests: write is required to create a Jira Flow Pull Request");
  const repository = parseGitHubRepository(config.repositoryUrl!);
  const headers = githubHeaders(config.githubToken);
  const branch = `bot/${event.issue_key}`;
  const existingEndpoint = new URL(`https://api.github.com/repos/${repository.owner}/${repository.name}/pulls`);
  existingEndpoint.searchParams.set("state", "open");
  existingEndpoint.searchParams.set("head", `${repository.owner}:${branch}`);
  existingEndpoint.searchParams.set("base", config.repositoryBranch);
  const existingResponse = await fetchImpl(new Request(existingEndpoint, { headers }));
  if (!existingResponse.ok) throw new Error(`GitHub Pull Request lookup failed (${existingResponse.status}): ${await existingResponse.text()}`);
  const existing = await existingResponse.json() as Array<Partial<GitHubPullRequest>>;
  if (existing.length > 0 && Number.isInteger(existing[0].number) && typeof existing[0].html_url === "string") {
    return { number: existing[0].number!, html_url: existing[0].html_url };
  }
  const response = await fetchImpl(new Request(`https://api.github.com/repos/${repository.owner}/${repository.name}/pulls`, {
    method: "POST", headers,
    body: JSON.stringify({
      title: `[${event.issue_key}] 自动化测试结果`, head: branch, base: config.repositoryBranch,
      body: `Jira: ${eventUrl(event)}\n\n由 AgentLattice Jira Automation Flow 自动创建。请在此 PR 评论提出修改意见，系统会恢复同一 QA Agent Session。`,
    }),
  }));
  if (!response.ok) throw new Error(`GitHub Pull Request creation failed (${response.status}): ${await response.text()}`);
  const payload = await response.json() as Partial<GitHubPullRequest>;
  if (typeof payload.number !== "number" || !Number.isInteger(payload.number) || typeof payload.html_url !== "string") {
    throw new Error("GitHub Pull Request creation returned invalid payload");
  }
  return { number: payload.number, html_url: payload.html_url };
}

async function bindPullRequest(
  config: JiraAutomationRunnerConfig,
  projectId: string,
  pullRequest: GitHubPullRequest,
  fetchImpl: typeof fetch,
): Promise<void> {
  const repositoryId = await getGitHubRepositoryId(config, parseGitHubRepository(config.repositoryUrl!), fetchImpl);
  const response = await fetchImpl(new Request(`${config.prFeedbackUrl}/internal/project-sessions/${encodeURIComponent(projectId)}/bind-pr`, {
    method: "POST", headers: internalHeaders(config), body: JSON.stringify({ repository_id: repositoryId, pr_number: pullRequest.number }),
  }));
  if (!response.ok) throw new Error(`GitHub Pull Request binding failed (${response.status})`);
}

async function getGitHubRepositoryId(
  config: JiraAutomationRunnerConfig,
  repository: { owner: string; name: string },
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(new Request(`https://api.github.com/repos/${repository.owner}/${repository.name}`, {
    headers: githubHeaders(config.githubToken!),
  }));
  if (!response.ok) throw new Error(`GitHub repository lookup failed (${response.status}): ${await response.text()}`);
  const payload = await response.json() as { id?: unknown };
  const id = String(payload.id ?? "").trim();
  if (!id) throw new Error("GitHub repository lookup returned invalid payload");
  return id;
}

function parseGitHubRepository(url: string): { owner: string; name: string } {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error("JIRA_AUTOMATION_REPOSITORY_URL must be a GitHub HTTPS repository URL");
  return { owner: match[1], name: match[2] };
}

function githubHeaders(token: string): Record<string, string> {
  return { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "AgentLattice-Jira-Flow" };
}

export function isReadinessBlocked(output: string): boolean {
  // Prefer the explicit machine marker, while accepting prior Skill output so
  // that a wording change cannot accidentally publish a blocked Jira project.
  if (/QA_READINESS\s*[:=]\s*BLOCK/i.test(output)) return true;
  return /(?:测试|提测)?准入(?:结论|审核|判断)?[\s:：|*_`-]*(?:不通过|block|blocked|失败)/i.test(output);
}

function truncateIssueBody(output: string): string {
  const maxLength = 12_000;
  return output.length <= maxLength ? output : `${output.slice(0, maxLength)}\n\n> 报告过长，已截断；完整报告在 Flow 工作目录中。`;
}

interface ExistingProjectSession { project_id: string; provider_session_id?: string; issue_number?: number; }

async function findProjectSession(config: JiraAutomationRunnerConfig, event: AutomationEvent, fetchImpl: typeof fetch): Promise<ExistingProjectSession | undefined> {
  const endpoint = new URL(`${config.prFeedbackUrl}/internal/project-sessions`);
  endpoint.searchParams.set("flow_id", config.flowId);
  endpoint.searchParams.set("repository", config.repositoryUrl!);
  endpoint.searchParams.set("jira_key", event.issue_key);
  const response = await fetchImpl(new Request(endpoint, { headers: internalHeaders(config) }));
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`project session lookup failed (${response.status})`);
  const body = await response.json() as { session?: ExistingProjectSession };
  if (!body.session?.project_id) throw new Error("project session lookup returned invalid data");
  return body.session;
}

async function materializeRuntimeEnv(repository: string, jiraKey: string, runtimeEnv: Record<string, string>): Promise<void> {
  const content = serializeRuntimeEnv(runtimeEnv);
  if (!content) return;
  // The system runtime inherits these values as process.env. Keep a private dotenv
  // alongside the generated Jira project too, because generated Python projects load
  // PROJECT_DIR/.env rather than the repository root.
  await writeFile(join(repository, ".env"), content, { mode: 0o600 });
  await writeFile(join(repository, jiraKey, ".env"), content, { mode: 0o600 });
  // Keep both runtime-only files out of Git status and any later publish flow.
  await appendFile(join(repository, ".git", "info", "exclude"), "\n# Jira Automation Flow runtime environment\n.env\n", { mode: 0o600 });
}

function parseRuntimeEnv(content?: string): Record<string, string> {
  if (!content?.trim()) return {};
  const result: Record<string, string> = {};
  for (const [index, source] of content.replace(/\r\n/g, "\n").split("\n").entries()) {
    const line = source.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]{0,127})=(.*)$/);
    if (!match) throw new Error(`runtime .env line ${index + 1} is invalid`);
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) result[key] = value;
  }
  return result;
}

function normalizeRuntimeEnv(runtimeEnv: Record<string, string>): Record<string, string> {
  const normalized = { ...runtimeEnv };
  const aliases: Record<string, string> = {
    NGI_BASE_URL: "EASEMOB_BASE_URL",
    NGI_APPKEY: "EASEMOB_APPKEY",
    NGI_CLIENT_ID: "EASEMOB_CLIENT_ID",
    NGI_CLIENT_SECRET: "EASEMOB_CLIENT_SECRET",
    NGI_FUSION_WS_URL: "EASEMOB_FUSION_WS_URL",
  };
  for (const [source, target] of Object.entries(aliases)) {
    if (normalized[source] && !normalized[target]) normalized[target] = normalized[source];
  }
  return normalized;
}

function serializeRuntimeEnv(runtimeEnv: Record<string, string>): string {
  return Object.entries(runtimeEnv).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}

async function installSkills(botRoot: string, skills: string[], skillsRoot?: string): Promise<void> {
  const target = join(botRoot, ".claude", "skills");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const skill of skills) {
    const source = skillsRoot ? join(skillsRoot, skill) : "";
    if (!source || !existsSync(join(source, "SKILL.md"))) {
      throw new Error(`selected local Skill is unavailable: ${skill}`);
    }
    await cp(source, join(target, skill), { recursive: true, force: true });
    // Existing uploads made before executable-mode support may contain run.sh as 0600.
    await chmod(join(target, skill, "scripts", "run.sh"), 0o700).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function publishJiraProject(config: JiraAutomationRunnerConfig, repository: string, jiraKey: string): Promise<void> {
  if (!config.githubToken) throw new Error("GITHUB_TOKEN is required when automatic GitHub publish is enabled");
  const reportsRoot = join(repository, jiraKey, "reports");
  const reportFiles = await readdir(reportsRoot, { withFileTypes: true }).catch(() => []);
  if (!reportFiles.some((entry) => entry.isFile() && entry.name.endsWith(".md"))) {
    throw new Error(`cannot publish ${jiraKey}: no current Run Markdown report was created`);
  }
  await git(["-C", repository, "add", "--", jiraKey], config.githubToken);
  if (!await gitSucceeds(["-C", repository, "diff", "--cached", "--quiet"], config.githubToken)) {
    await git([
      "-C", repository, "-c", "user.name=AgentLattice Jira Flow", "-c", "user.email=agentlattice-jira-flow@localhost",
      "commit", "-m", `test(${jiraKey}): automated Jira Flow result`,
    ], config.githubToken);
    await git(["-C", repository, "push", "origin", `HEAD:refs/heads/bot/${jiraKey}`], config.githubToken);
  }
}

function buildPrompt(event: AutomationEvent, autoExecute: boolean, runtimeEnvKeys: string[]): string { return `你正在执行系统 Jira Automation Flow，不是普通 Bot，也不与用户聊天。\n\n# System Flow Rules（优先于任何已安装 Skill 中面向普通 Bot 的通用规则）\n\n1. 本 Run 使用管理员配置的系统环境、System Flow 工作目录和系统 Jira 凭证；不得要求 /env、/jira bind、用户确认或用户 Bot 配置。\n2. 只能修改 repository/${event.issue_key}/ 及其 reports/；不得读取父目录、其他 Jira 目录或任何普通 Bot 工作区。\n3. 测试准入不通过时，停止在缺失项与风险报告；不得编造代码、环境或执行结果。\n4. 历史 Jira 评论、附件和历史报告只能标为“历史参考”，绝不能写成本次 pytest 的通过结果。\n5. 不得 push、创建 PR、评论 Jira 或上传附件。\n${autoExecute ? "6. 管理员已为当前 Jira 明确预授权用例确认。若测试准入通过，必须继续使用 easemob-qa-automation-project 创建 repository/" + event.issue_key + "/ 的自动化项目、编写代码、校验已配置环境并执行真实测试；不得在用例草稿后停止。此规则覆盖已安装 Skill 中仅适用于普通 Bot 的“等待当前用户确认用例”和“请求 /env set”步骤。" : "6. 当前为人工确认模式：只输出测试准入与完整用例草稿，不得创建测试代码或执行测试。"}\n7. 已配置运行环境变量（仅列键名，不得输出值）：${runtimeEnvKeys.length > 0 ? runtimeEnvKeys.join(", ") : "无"}。这些值已注入当前 CLI 进程，并写入 repository/${event.issue_key}/.env；对列出的键不得再向用户索取或报告为缺失，先用于真实校验。\n8. 最终报告必须单独输出一行机器状态：准入通过写 \`QA_READINESS: PASS\`；准入不通过、阻塞或条件不足写 \`QA_READINESS: BLOCK\`。\n\nJira：${event.issue_key}\n链接：${eventUrl(event)}\n事件：${event.event_type}\n\n本次 Run 已创建独立项目 repository/${event.issue_key}/。先读取 RUN_CONTEXT.md，再使用本 Flow 安装的 Skills 完成当前 Jira 工作。环境缺失时必须列出准确变量名并停止。完成后把报告写入 repository/${event.issue_key}/reports/。`; }
function eventUrl(event: AutomationEvent): string { return typeof event.payload.url === "string" ? event.payload.url : `Jira Key: ${event.issue_key}`; }
function shortHash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 12); }
function sameRepositoryUrl(left: string, right: string): boolean {
  return left.trim().replace(/\/$/, "").replace(/\.git$/, "") === right.trim().replace(/\/$/, "").replace(/\.git$/, "");
}
function internalHeaders(config: Pick<JiraAutomationRunnerConfig, "internalToken">): Record<string, string> { return { "content-type": "application/json", authorization: `Bearer ${config.internalToken}` }; }
async function git(args: string[], token?: string): Promise<void> { await new Promise<void>((resolve, reject) => execFile("git", args, { env: { ...process.env, ...(token ? { GITHUB_TOKEN: token, GIT_ASKPASS: "/usr/local/bin/git-askpass", GIT_TERMINAL_PROMPT: "0" } : {}) } }, (error) => error ? reject(error) : resolve())); }
async function gitOutput(args: string[], token?: string): Promise<string> { return new Promise((resolve, reject) => execFile("git", args, { env: { ...process.env, ...(token ? { GITHUB_TOKEN: token, GIT_ASKPASS: "/usr/local/bin/git-askpass", GIT_TERMINAL_PROMPT: "0" } : {}) } }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))); }
async function gitSucceeds(args: string[], token?: string): Promise<boolean> { return new Promise((resolve) => execFile("git", args, { env: { ...process.env, ...(token ? { GITHUB_TOKEN: token, GIT_ASKPASS: "/usr/local/bin/git-askpass", GIT_TERMINAL_PROMPT: "0" } : {}) } }, (error) => resolve(!error))); }
