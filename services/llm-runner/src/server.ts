import { parseChatRequest, type ChatResponse } from "@my-agent-toolkit/contracts";
import { loadRunnerConfig, type RunnerConfig } from "./config.js";
import { getRuntimeStatuses } from "./runtimeStatus.js";
import {
  RuntimeExecutionError,
  runCliRuntime,
  runCliRuntimeStream,
  runMockRuntime,
  runMockRuntimeStream,
  type RuntimeResult,
  type RuntimeStreamResult,
} from "./runtimes.js";

export interface LlmRunnerServer {
  fetch(request: Request): Promise<Response>;
}

export function createLlmRunnerServer(
  config: RunnerConfig = loadRunnerConfig(),
): LlmRunnerServer {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          service: "llm-runner",
          status: "ok",
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/runtimes") {
        return jsonResponse({
          runtimes: await getRuntimeStatuses(config),
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/chat") {
        return handleChat(request, config);
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/stream") {
        return handleChatStream(request, config);
      }

      return jsonResponse({ error: "not found" }, 404);
    },
  };
}

async function handleChatStream(
  request: Request,
  config: RunnerConfig,
): Promise<Response> {
  try {
    const chatRequest = parseChatRequest(await request.json());
    const runtimeResult = runRuntimeStream(config, chatRequest);
    const runId = `run_${crypto.randomUUID()}`;
    const encoder = new TextEncoder();

    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(ndjsonLine({
            type: "run",
            run_id: runId,
            runner_session_id: runtimeResult.runner_session_id,
          })));

          const reader = runtimeResult.stream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              if (value) {
                controller.enqueue(encoder.encode(ndjsonLine({
                  type: "chunk",
                  content: value,
                })));
              }
            }
            controller.enqueue(encoder.encode(ndjsonLine({ type: "done" })));
            controller.close();
          } catch (error) {
            controller.enqueue(encoder.encode(ndjsonLine(runtimeStreamErrorPayload(error))));
            controller.close();
          }
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
          "cache-control": "no-cache",
        },
      },
    );
  } catch (error) {
    if (error instanceof UnavailableRuntimeError) {
      return jsonResponse({ error: error.message }, 501);
    }
    return jsonResponse(
      { error: error instanceof Error ? error.message : "invalid request" },
      400,
    );
  }
}

async function handleChat(
  request: Request,
  config: RunnerConfig,
): Promise<Response> {
  try {
    const chatRequest = parseChatRequest(await request.json());
    const runtimeResult = await runRuntime(config, chatRequest);
    const response: ChatResponse = {
      run_id: `run_${crypto.randomUUID()}`,
      runner_session_id: runtimeResult.runner_session_id,
      output: runtimeResult.output,
    };

    return jsonResponse(response);
  } catch (error) {
    if (error instanceof UnavailableRuntimeError) {
      return jsonResponse({ error: error.message }, 501);
    }

    if (error instanceof RuntimeExecutionError) {
      return jsonResponse(
        {
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        },
        error.status,
      );
    }

    return jsonResponse(
      { error: error instanceof Error ? error.message : "invalid request" },
      400,
    );
  }
}

async function runRuntime(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
): Promise<RuntimeResult> {
  if (!config.enabled_runtimes.includes(chatRequest.runtime)) {
    throw new UnavailableRuntimeError("runtime is not available yet");
  }

  if (chatRequest.runtime === "mock") {
    return runMockRuntime(chatRequest);
  }

  if (chatRequest.runtime === "kiro" && config.kiro) {
    return runCliRuntime(config.kiro, chatRequest);
  }

  throw new UnavailableRuntimeError("runtime is not available yet");
}

function runRuntimeStream(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
): RuntimeStreamResult {
  if (!config.enabled_runtimes.includes(chatRequest.runtime)) {
    throw new UnavailableRuntimeError("runtime is not available yet");
  }

  if (chatRequest.runtime === "mock") {
    return runMockRuntimeStream(chatRequest);
  }

  if (chatRequest.runtime === "kiro" && config.kiro) {
    return runCliRuntimeStream(config.kiro, chatRequest);
  }

  throw new UnavailableRuntimeError("runtime is not available yet");
}

function ndjsonLine(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}

function runtimeStreamErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof RuntimeExecutionError) {
    return {
      type: "error",
      error: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return {
    type: "error",
    error: error instanceof Error ? error.message : "runtime stream failed",
  };
}

class UnavailableRuntimeError extends Error {}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
