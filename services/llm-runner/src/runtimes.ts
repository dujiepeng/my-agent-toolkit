import { spawn } from "node:child_process";
import type { ChatRequest, RuntimeName } from "@my-agent-toolkit/contracts";
import { redactText } from "./redact.js";

export interface RuntimeResult {
  runner_session_id: string;
  output: string;
}

export interface RuntimeStreamResult {
  runner_session_id: string;
  stream: ReadableStream<string>;
}

export interface CliRuntimeConfig {
  command: string;
  args: string[];
  timeout_ms: number;
  env?: Record<string, string>;
}

export class RuntimeExecutionError extends Error {
  constructor(
    public readonly code:
      | "runtime_exit"
      | "runtime_timeout"
      | "runtime_spawn_error",
    public readonly status: number,
    message: string,
    public readonly details?: string,
  ) {
    super(message);
  }
}

export async function runMockRuntime(
  request: ChatRequest,
): Promise<RuntimeResult> {
  return {
    runner_session_id: buildRunnerSessionId("mock", request),
    output: `mock: ${request.prompt}`,
  };
}

export async function runCliRuntime(
  config: CliRuntimeConfig,
  request: ChatRequest,
): Promise<RuntimeResult> {
  const runnerSessionId = buildRunnerSessionId(request.runtime, request);
  const output = await runProcess(config, request.prompt, runnerSessionId);
  return {
    runner_session_id: runnerSessionId,
    output,
  };
}

export function runMockRuntimeStream(
  request: ChatRequest,
): RuntimeStreamResult {
  return {
    runner_session_id: buildRunnerSessionId("mock", request),
    stream: new ReadableStream<string>({
      start(controller) {
        controller.enqueue(`mock: ${request.prompt}`);
        controller.close();
      },
    }),
  };
}

export function runCliRuntimeStream(
  config: CliRuntimeConfig,
  request: ChatRequest,
): RuntimeStreamResult {
  const runnerSessionId = buildRunnerSessionId(request.runtime, request);
  return {
    runner_session_id: runnerSessionId,
    stream: streamProcess(config, request.prompt, runnerSessionId),
  };
}

function buildRunnerSessionId(
  runtime: RuntimeName,
  request: Pick<ChatRequest, "bot_id" | "user_id" | "conversation_id">,
): string {
  return [runtime, request.bot_id, request.user_id, request.conversation_id].join(
    ":",
  );
}

const startedRunnerSessions = new Set<string>();

function runProcess(config: CliRuntimeConfig, input: string, runnerSessionId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = argsForRunnerSession(config.args, runnerSessionId);
    const child = spawn(config.command, args, {
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(
        new RuntimeExecutionError(
          "runtime_timeout",
          504,
          "runtime timed out",
        ),
      );
    }, config.timeout_ms);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(
        new RuntimeExecutionError(
          "runtime_spawn_error",
          502,
          "runtime failed to start",
          redactText(error.message),
        ),
      );
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        reject(
          new RuntimeExecutionError(
            "runtime_exit",
            502,
            `runtime exited with code ${code ?? "unknown"}`,
            redactText(Buffer.concat(stderr).toString()),
          ),
        );
        return;
      }

      startedRunnerSessions.add(runnerSessionId);
      resolve(Buffer.concat(stdout).toString());
    });

    child.stdin.end(input);
  });
}

function streamProcess(config: CliRuntimeConfig, input: string, runnerSessionId: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      const args = argsForRunnerSession(config.args, runnerSessionId);
      const child = spawn(config.command, args, {
        env: { ...process.env, ...config.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stderr: Buffer[] = [];
      let settled = false;
      const fail = (error: RuntimeExecutionError) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        controller.error(error);
      };
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        fail(new RuntimeExecutionError("runtime_timeout", 504, "runtime timed out"));
      }, config.timeout_ms);

      child.stdout.on("data", (chunk: Buffer) => {
        controller.enqueue(chunk.toString());
      });
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) => {
        fail(
          new RuntimeExecutionError(
            "runtime_spawn_error",
            502,
            "runtime failed to start",
            redactText(error.message),
          ),
        );
      });
      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (code !== 0) {
          controller.error(
            new RuntimeExecutionError(
              "runtime_exit",
              502,
              `runtime exited with code ${code ?? "unknown"}`,
              redactText(Buffer.concat(stderr).toString()),
            ),
          );
          return;
        }
        startedRunnerSessions.add(runnerSessionId);
        controller.close();
      });

      child.stdin.end(input);
    },
  });
}

function argsForRunnerSession(args: string[], runnerSessionId: string): string[] {
  if (!startedRunnerSessions.has(runnerSessionId)) {
    return [...args];
  }

  const chatIndex = args.indexOf("chat");
  if (chatIndex < 0 || args.includes("--resume") || args.includes("--resume-id")) {
    return [...args];
  }

  const nextArgs = [...args];
  nextArgs.splice(chatIndex + 1, 0, "--resume");
  return nextArgs;
}
