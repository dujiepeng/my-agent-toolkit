#!/usr/bin/env node

const chunks = [];

for await (const chunk of process.stdin) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}

process.stdout.write(`fake-kiro: ${Buffer.concat(chunks).toString()}`);
