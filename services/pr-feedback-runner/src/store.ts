import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ProjectSession {
  project_id: string;
  jira_key: string;
  flow_id: string;
  workspace_id: string;
  workspace_root: string;
  repository: string;
  branch: string;
  runtime: "kiro" | "claude-code" | "mock";
  provider_session_id?: string;
  head_sha: string;
  repository_id?: string;
  pr_number?: number;
  issue_number?: number;
  updated_at: string;
}

export interface FeedbackEvent {
  delivery_id: string;
  event_type: string;
  repository_id: string;
  target_type: "pull_request" | "issue";
  target_number: number;
  comment_id: string;
  comment_body: string;
  received_at: string;
  status: "pending" | "running" | "succeeded" | "failed";
  error?: string;
}

interface State { sessions: ProjectSession[]; }

export interface ProjectSessionStore {
  upsert(session: ProjectSession): Promise<ProjectSession>;
  bind(projectId: string, repositoryId: string, prNumber: number, now: string): Promise<ProjectSession | undefined>;
  find(repositoryId: string, prNumber: number): Promise<ProjectSession | undefined>;
  bindIssue(projectId: string, repositoryId: string, issueNumber: number, now: string): Promise<ProjectSession | undefined>;
  findIssue(repositoryId: string, issueNumber: number): Promise<ProjectSession | undefined>;
  findByKey(flowId: string, repository: string, jiraKey: string): Promise<ProjectSession | undefined>;
}

export function createJsonFileProjectSessionStore(filePath: string): ProjectSessionStore {
  let state: State = { sessions: [] };
  let loaded = false;
  let serial = Promise.resolve();
  const load = async () => {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<State>;
      state = { sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  const persist = async () => {
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, filePath);
  };
  const mutate = async <T>(work: () => T | Promise<T>): Promise<T> => {
    let result!: T;
    serial = serial.then(async () => { await load(); result = await work(); await persist(); });
    await serial;
    return result;
  };
  return {
    upsert: (session) => mutate(() => {
      const index = state.sessions.findIndex((item) => item.project_id === session.project_id);
      if (index >= 0) state.sessions[index] = { ...state.sessions[index], ...session };
      else state.sessions.push(session);
      return state.sessions.find((item) => item.project_id === session.project_id)!;
    }),
    bind: (projectId, repositoryId, prNumber, now) => mutate(() => {
      const session = state.sessions.find((item) => item.project_id === projectId);
      if (!session) return undefined;
      const conflict = state.sessions.find((item) => item.project_id !== projectId && item.repository_id === repositoryId && item.pr_number === prNumber);
      if (conflict) throw new Error("PR is already bound to another project session");
      Object.assign(session, { repository_id: repositoryId, pr_number: prNumber, updated_at: now });
      return session;
    }),
    find: async (repositoryId, prNumber) => {
      await load();
      return state.sessions.find((item) => item.repository_id === repositoryId && item.pr_number === prNumber);
    },
    bindIssue: (projectId, repositoryId, issueNumber, now) => mutate(() => {
      const session = state.sessions.find((item) => item.project_id === projectId);
      if (!session) return undefined;
      const conflict = state.sessions.find((item) => item.project_id !== projectId && item.repository_id === repositoryId && item.issue_number === issueNumber);
      if (conflict) throw new Error("GitHub Issue is already bound to another project session");
      Object.assign(session, { repository_id: repositoryId, issue_number: issueNumber, updated_at: now });
      return session;
    }),
    findIssue: async (repositoryId, issueNumber) => {
      await load();
      return state.sessions.find((item) => item.repository_id === repositoryId && item.issue_number === issueNumber);
    },
    findByKey: async (flowId, repository, jiraKey) => {
      await load();
      return state.sessions.find((item) => item.flow_id === flowId && item.repository === repository && item.jira_key === jiraKey);
    },
  };
}
