import { parseChatRequest, type ChatResponse } from "@my-agent-toolkit/contracts";
import { loadRunnerConfig, type RunnerConfig } from "./config.js";
import {
  callMcpTool,
  fetchMcpToolManifest,
  formatMcpToolResult,
  injectMcpPromptSection,
  parseMcpToolCall,
} from "./mcpClient.js";
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
    const runtimeRequest = await enrichChatRequest(config, chatRequest);
    const runtimeResult = runRuntimeStream(config, runtimeRequest);
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

          try {
            if (!config.mcp) {
              await pipeRuntimeStream(runtimeResult.stream, controller, encoder);
              controller.enqueue(encoder.encode(ndjsonLine({ type: "done" })));
              controller.close();
              return;
            }
            const firstOutput = await collectRuntimeStream(runtimeResult.stream);
            const toolCall = config.mcp ? parseMcpToolCall(firstOutput) : undefined;
            if (!toolCall) {
              enqueueChunk(controller, encoder, firstOutput);
            } else {
              const toolResult = await executeMcpToolCall(config, chatRequest, toolCall);
              const secondRuntimeResult = runRuntimeStream(config, {
                ...chatRequest,
                prompt: toolResult,
              });
              await pipeRuntimeStream(secondRuntimeResult.stream, controller, encoder);
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

async function collectRuntimeStream(stream: ReadableStream<string>): Promise<string> {
  const chunks: string[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
    }
  }
  return chunks.join("");
}

async function pipeRuntimeStream(
  stream: ReadableStream<string>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<void> {
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    enqueueChunk(controller, encoder, value);
  }
}

function enqueueChunk(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  value: string | undefined,
): void {
  if (!value) {
    return;
  }
  controller.enqueue(encoder.encode(ndjsonLine({
    type: "chunk",
    content: value,
  })));
}

async function handleChat(
  request: Request,
  config: RunnerConfig,
): Promise<Response> {
  try {
    const chatRequest = parseChatRequest(await request.json());
    const runtimeRequest = await enrichChatRequest(config, chatRequest);
    const runtimeResult = await runRuntime(config, runtimeRequest);
    const finalResult = await continueAfterMcpToolCall(config, chatRequest, runtimeResult);
    const response: ChatResponse = {
      run_id: `run_${crypto.randomUUID()}`,
      runner_session_id: finalResult.runner_session_id,
      output: finalResult.output,
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

async function continueAfterMcpToolCall(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
  runtimeResult: RuntimeResult,
): Promise<RuntimeResult> {
  if (!config.mcp) {
    return runtimeResult;
  }
  const toolCall = parseMcpToolCall(runtimeResult.output);
  if (!toolCall) {
    return runtimeResult;
  }
  const toolResult = await executeMcpToolCall(config, chatRequest, toolCall);
  return runRuntime(config, {
    ...chatRequest,
    prompt: toolResult,
  });
}

async function executeMcpToolCall(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
  toolCall: NonNullable<ReturnType<typeof parseMcpToolCall>>,
): Promise<string> {
  if (!config.mcp) {
    return formatMcpToolResult({
      ok: false,
      error: "mcp is not configured",
    });
  }
  try {
    const result = await callMcpTool({
      ...config.mcp,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    }, {
      bot_id: chatRequest.bot_id,
      user_id: chatRequest.user_id,
      conversation_id: chatRequest.conversation_id,
      runtime: chatRequest.runtime,
    }, toolCall);
    return formatMcpToolResult(result);
  } catch (error) {
    return formatMcpToolResult({
      ok: false,
      error: error instanceof Error ? error.message : "mcp tool call failed",
    });
  }
}

async function enrichChatRequest(
  config: RunnerConfig,
  chatRequest: ReturnType<typeof parseChatRequest>,
): Promise<ReturnType<typeof parseChatRequest>> {
  if (!config.mcp) {
    return chatRequest;
  }
  try {
    const manifest = await fetchMcpToolManifest({
      ...config.mcp,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    }, {
      bot_id: chatRequest.bot_id,
      user_id: chatRequest.user_id,
      conversation_id: chatRequest.conversation_id,
      runtime: chatRequest.runtime,
    });
    return {
      ...chatRequest,
      prompt: injectMcpPromptSection(chatRequest.prompt, manifest),
    };
  } catch {
    return chatRequest;
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
