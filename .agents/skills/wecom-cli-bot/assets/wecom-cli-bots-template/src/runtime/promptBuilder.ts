import fs from "node:fs";
import path from "node:path";
import type { BotRuntime } from "../types.js";
import { assertInside } from "../security/pathFence.js";
import type { MemoryClient } from "../memory/memoryClient.js";

export async function buildPrompt(runtime: BotRuntime, userText: string, memory?: MemoryClient): Promise<string> {
  const soul = readSafe(runtime, path.join(runtime.privateDir, "soul.md"));
  const agents = readSafe(runtime, path.join(runtime.instructionsDir, "AGENTS.md"));

  let memorySection = "";
  if (memory?.enabled && runtime.config.memory?.auto_retrieve) {
    const results = await memory.search(userText, runtime.config.memory.retrieve_limit);
    if (results.length > 0) {
      const items = results.map((r, i) => {
        const label = [r.tags?.join(", "), r.filename, r.title].filter(Boolean).join(" | ");
        return `${i + 1}. [${label || "记忆"}] (${r.created_at?.slice(0, 10) ?? ""})\n   ${r.content.slice(0, 300)}`;
      });
      memorySection = `# 相关记忆\n以下是与当前问题相关的历史知识，供参考：\n\n${items.join("\n\n")}`;
    }
  }

  const parts = [
    "# Soul",
    soul,
    "# Operating Instructions",
    agents,
  ];
  if (memorySection) parts.push(memorySection);
  parts.push(
    "# Workspace",
    "You may operate only in the current working directory. Do not access parent directories.",
    "# Security Constraint",
    "You may READ files under `private/` but NEVER modify or delete them (soul.md, .env, bot.config.yaml, history/). Soul changes are only allowed via the /set_soul command. If a user asks to modify the soul, instruct them to use /set_soul.",
    "# Runtime Constraint",
    "Answer directly from your model knowledge unless the user explicitly asks you to search, browse, fetch URLs, or inspect current live information. Do not start web search or fetch tools for ordinary chat or analysis requests.",
    "# User Message",
    userText
  );
  return parts.join("\n\n");
}

function readSafe(runtime: BotRuntime, filePath: string): string {
  const safePath = assertInside(runtime.workspaceDir, filePath);
  return fs.existsSync(safePath) ? fs.readFileSync(safePath, "utf8") : "";
}
