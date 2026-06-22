#!/usr/bin/env node

const relayUrl = process.env.KIRO_RELAY_URL ?? "http://host.docker.internal:8210/v1/kiro/chat";
const relayStreamUrl = process.env.KIRO_RELAY_STREAM_URL ?? relayUrl.replace(/\/v1\/kiro\/chat$/, "/v1/kiro/chat/stream");
const streamEnabled = process.env.KIRO_RELAY_STREAM === "true";
const forwardedArgs = process.argv.slice(2);
const chunks = [];

for await (const chunk of process.stdin) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}

try {
  if (streamEnabled) {
    await runStream(Buffer.concat(chunks).toString());
    process.exit(0);
  }

  const response = await fetch(relayUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: Buffer.concat(chunks).toString(),
      args: forwardedArgs,
    }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_error) {
    payload = undefined;
  }

  if (!response.ok) {
    process.stderr.write(payload?.error ?? text ?? `kiro relay failed with ${response.status}`);
    process.exit(1);
  }

  if (typeof payload?.output !== "string") {
    process.stderr.write("kiro relay returned invalid output");
    process.exit(1);
  }

  process.stdout.write(payload.output);
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : "kiro relay request failed");
  process.exit(1);
}

async function runStream(prompt) {
  const response = await fetch(relayStreamUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, args: forwardedArgs }),
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    process.stderr.write(text || `kiro relay stream failed with ${response.status}`);
    process.exit(1);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      handleStreamLine(line);
    }
  }
  if (buffer.trim()) {
    handleStreamLine(buffer);
  }
}

function handleStreamLine(line) {
  if (!line.trim()) {
    return;
  }
  const event = JSON.parse(line);
  if (event.type === "chunk" && typeof event.content === "string") {
    process.stdout.write(event.content);
    return;
  }
  if (event.type === "done") {
    return;
  }
  if (event.type === "error") {
    process.stderr.write(event.error ?? "kiro relay stream failed");
    process.exit(1);
  }
}
