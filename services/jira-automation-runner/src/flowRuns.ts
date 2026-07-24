import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type FlowRunStatus = "running" | "succeeded" | "blocked" | "failed";
export type FlowRunStepStatus = "running" | "succeeded" | "blocked" | "failed";

export interface FlowRunStep {
  stage: string;
  status: FlowRunStepStatus;
  message: string;
  created_at: string;
}

export interface FlowRunRecord {
  run_id: string;
  jira_key: string;
  title: string;
  runtime: "kiro" | "claude-code" | "mock";
  status: FlowRunStatus;
  current_stage: string;
  workspace_id: string;
  branch: string;
  started_at: string;
  finished_at?: string;
  issue_url?: string;
  pull_request_url?: string;
  report_path?: string;
  steps: FlowRunStep[];
}

interface FlowRunFile { runs: FlowRunRecord[]; }

let serial = Promise.resolve();

export class FlowRunReporter {
  constructor(private readonly file?: string) {}

  async start(run: Omit<FlowRunRecord, "steps" | "status" | "current_stage" | "started_at">): Promise<void> {
    await this.mutate((runs) => {
      const now = new Date().toISOString();
      const record: FlowRunRecord = {
        ...run, status: "running", current_stage: "received", started_at: now,
        steps: [{ stage: "received", status: "succeeded", message: "已接收 Jira Webhook", created_at: now }],
      };
      const index = runs.findIndex((item) => item.run_id === run.run_id);
      if (index >= 0) runs[index] = record;
      else runs.unshift(record);
    });
  }

  async step(runId: string, stage: string, status: FlowRunStepStatus, message: string): Promise<void> {
    await this.mutate((runs) => {
      const run = runs.find((item) => item.run_id === runId);
      if (!run) return;
      const now = new Date().toISOString();
      run.current_stage = stage;
      run.steps.push({ stage, status, message, created_at: now });
      run.steps = run.steps.slice(-24);
    });
  }

  async finish(runId: string, status: Exclude<FlowRunStatus, "running">, stage: string, message: string, artifacts: Partial<Pick<FlowRunRecord, "issue_url" | "pull_request_url" | "report_path">> = {}): Promise<void> {
    await this.mutate((runs) => {
      const run = runs.find((item) => item.run_id === runId);
      if (!run) return;
      const now = new Date().toISOString();
      run.status = status;
      run.current_stage = stage;
      run.finished_at = now;
      Object.assign(run, artifacts);
      run.steps.push({ stage, status: status === "blocked" ? "blocked" : status === "failed" ? "failed" : "succeeded", message, created_at: now });
      run.steps = run.steps.slice(-24);
    });
  }

  private async mutate(update: (runs: FlowRunRecord[]) => void): Promise<void> {
    if (!this.file) return;
    let complete!: () => void;
    const previous = serial;
    serial = new Promise<void>((resolve) => { complete = resolve; });
    await previous;
    try {
      let state: FlowRunFile = { runs: [] };
      try {
        const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<FlowRunFile>;
        state.runs = Array.isArray(parsed.runs) ? parsed.runs : [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      update(state.runs);
      state.runs = state.runs.slice(0, 100);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.file);
    } finally { complete(); }
  }
}
