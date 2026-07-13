# 项目 Agent 指南

本仓库维护个人使用的 Agent 技能和服务。

## 当前技能

### wecom-cli-bot

```text
.agents/skills/wecom-cli-bot
```

企业微信 CLI 机器人框架技能。生成的项目将企业微信智能机器人长连接消息桥接到 AI CLI 工具（Kimi Code、Kiro CLI、Codex、Claude Code）。

### bot-memory

```text
.agents/skills/bot-memory
```

Bot 记忆技能。指导 Bot 如何与 Memory Service 交互，实现长期知识存储和自动检索注入。

## 服务

```text
services/memory-service
```

独立部署的记忆服务（FastAPI + ChromaDB + fastembed），为所有 Bot 提供知识库能力。

## 维护规则

- 技能修改仅在 `.agents/skills/` 对应子目录下进行。
- 服务实现代码在 `services/` 目录。
- 不要在仓库中存储真实凭证（Bot ID、Secret、API Key）。
- `.env.example` 文件仅保留占位符。
- 优先使用 Docker 模式验证。

## 验证

wecom-cli-bot 技能验证：

```bash
cd .agents/skills/wecom-cli-bot/assets/wecom-cli-bots-template
npm install && npm run typecheck
```

Memory Service 验证：

```bash
cd services/memory-service
docker compose up -d
curl http://localhost:8100/health
```

# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
