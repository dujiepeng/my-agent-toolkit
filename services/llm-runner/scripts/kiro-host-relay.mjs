#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";

const port = Number.parseInt(process.env.KIRO_HOST_RELAY_PORT ?? "8210", 10);
const host = process.env.KIRO_HOST_RELAY_HOST ?? "127.0.0.1";
const command = process.env.KIRO_COMMAND ?? "/Users/dujiepeng/.local/bin/kiro-cli";
const args = parseArgs(process.env.KIRO_ARGS ?? "chat --no-interactive --trust-all-tools");
const timeoutMs = Number.parseInt(process.env.KIRO_TIMEOUT_MS ?? "120000", 10);

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    writeJson(response, 200, { service: "kiro-host-relay", status: "ok" });
    return;
  }

  if (request.method === "POST" && request.url === "/v1/kiro/chat/stream") {
    try {
      const payload = JSON.parse(await readBody(request));
      if (typeof payload.prompt !== "string") {
        writeJson(response, 400, { error: "prompt is required" });
        return;
      }

      response.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
      });
      const requestArgs = argsFromPayload(payload);
      await streamKiro(payload.prompt, requestArgs, (event) => {
        response.write(`${JSON.stringify(event)}\n`);
      });
      response.end(`${JSON.stringify({ type: "done" })}\n`);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-cache",
        });
      }
      response.end(`${JSON.stringify({
        type: "error",
        error: error instanceof Error ? error.message : "kiro relay failed",
      })}\n`);
    }
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/kiro/chat") {
    writeJson(response, 404, { error: "not found" });
    return;
  }

  try {
    const payload = JSON.parse(await readBody(request));
    if (typeof payload.prompt !== "string") {
      writeJson(response, 400, { error: "prompt is required" });
      return;
    }

    const requestArgs = argsFromPayload(payload);
    const output = await runKiro(payload.prompt, requestArgs);
    writeJson(response, 200, { output });
  } catch (error) {
    writeJson(response, 502, {
      error: error instanceof Error ? error.message : "kiro relay failed",
    });
  }
});

server.listen(port, host, () => {
  console.log(`kiro host relay listening on http://${host}:${port}`);
});

function runKiro(prompt, requestArgs = args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, requestArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("kiro runtime timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`kiro runtime exited with code ${code ?? "unknown"}: ${redact(Buffer.concat(stderr).toString())}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString());
    });
    child.stdin.end(prompt);
  });
}

function streamKiro(prompt, requestArgs = args, onEvent) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, requestArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("kiro runtime timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      onEvent({ type: "chunk", content: chunk.toString() });
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`kiro runtime exited with code ${code ?? "unknown"}: ${redact(Buffer.concat(stderr).toString())}`));
        return;
      }
      resolve();
    });
    child.stdin.end(prompt);
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

function writeJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function parseArgs(value) {
  return value.split(" ").map((item) => item.trim()).filter(Boolean);
}

function argsFromPayload(payload) {
  if (!Array.isArray(payload.args)) {
    return args;
  }

  const requestArgs = payload.args.filter((item) => typeof item === "string" && item.length > 0);
  return requestArgs.length > 0 ? requestArgs : args;
}

function redact(text) {
  return text
    .replace(/(token|secret|api[_-]?key|password)=\S+/gi, "$1=[REDACTED]")
    .replace(/\/Users\/\S+/g, "[PATH]")
    .trim();
}
