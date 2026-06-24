# Standard Role Question Set Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current default role set with five standard roles, clear old role/bot runtime data, and seed ready-to-review role documents and question sets directly into the WebUI.

**Architecture:** Seed replacement will be implemented as a deterministic reset flow in `data-service`, with one canonical in-memory seed definition mirrored into SQLite. The control plane and WebUI remain unchanged structurally, but tests and seed-driven expectations will be updated so the UI immediately shows the five standard roles and their question sets after reset.

**Tech Stack:** TypeScript, Node.js, SQLite, Vitest, existing Docker Compose deployment

---

## File Structure

- Modify: `services/data-service/src/store.ts`
  - Replace the current default role seed definition with five standard roles, their hidden `role.md` documents, and role question sets.
- Modify: `services/data-service/src/sqliteStore.ts`
  - Reuse the updated seed logic and add a deterministic reset helper that clears old bot/channel/runtime/role data while preserving `playground.md`.
- Modify: `services/data-service/src/store.test.ts`
  - Update in-memory seed assertions to the new five-role set and add reset behavior coverage.
- Modify: `services/data-service/src/sqliteStore.test.ts`
  - Update SQLite seed assertions and verify reset preserves `playground.md` while replacing role data.
- Modify: `services/data-service/src/server.ts`
  - Expose a narrow internal reset endpoint or reuse startup flow to trigger the standard-role reset safely.
- Modify: `services/data-service/src/server.test.ts`
  - Verify the reset entrypoint behavior and resulting API payloads.
- Modify: `services/control-api/src/server.test.ts`
  - Update role list and role detail expectations so the UI asserts the five new role names and representative question text.
- Modify: `services/bot-host/src/server.test.ts`
  - Update initialization expectations so role selection surfaces the five standard roles.
- Modify: `README.md`
  - Document that the default environment now seeds five standard roles.

---

### Task 1: Replace in-memory default role seed with five standard roles

**Files:**
- Modify: `services/data-service/src/store.ts`
- Test: `services/data-service/src/store.test.ts`

- [ ] **Step 1: Write the failing in-memory seed test for the five standard roles**

```ts
it("seeds the five standard roles with documents and question sets", () => {
  const store = createInMemoryDataStore();

  seedDefaultRoleConfig(store);

  expect(store.listRoles().map((role) => role.name)).toEqual([
    "产品经理",
    "测试工程师",
    "研发工程师",
    "市场人员",
    "运营人员",
  ]);

  const productManager = store.listRoles().find((role) => role.slug === "product-manager");
  expect(productManager).toBeDefined();

  const documents = store.listRoleDocuments(productManager!.role_id);
  expect(documents).toHaveLength(1);
  expect(documents[0]?.title).toBe("role.md");
  expect(String(documents[0]?.content ?? "")).toContain("角色定位");

  const questions = store.listRoleQuestions(productManager!.role_id);
  expect(questions.length).toBeGreaterThanOrEqual(5);
  expect(questions.map((question) => question.title)).toContain("你希望它用什么方式和你交互？");
});
```

- [ ] **Step 2: Run the targeted store test and verify it fails**

Run: `pnpm vitest run services/data-service/src/store.test.ts -t "seeds the five standard roles with documents and question sets"`
Expected: FAIL because the current seed still returns the old default role set.

- [ ] **Step 3: Replace the role seed definitions in `store.ts`**

```ts
const STANDARD_ROLE_SEEDS = [
  {
    slug: "product-manager",
    name: "产品经理",
    document: buildRoleDocument("产品经理", `# Role: Product Manager\n\n## 角色定位\n...`),
    questions: [
      buildQuestion("你希望它用什么方式和你交互？", ["逐句引导", "批量确认", "先给推荐方案，再确认"]),
      buildQuestion("是否需要长期沉淀规则和文档？", ["需要", "不需要"]),
      buildQuestion("默认输出更偏向哪类内容？", ["PRD", "需求评审", "用户故事", "拆解清单"]),
      buildQuestion("是否强调结构化结论？", ["是，先给结论再展开", "否，按过程展开即可"]),
      buildQuestion("是否需要优先给推荐方案？", ["需要", "不需要"]),
      buildQuestion("是否有额外工作规则？", []),
    ],
  },
  // qa-engineer, engineer, marketing, operations
];
```

```ts
export function seedDefaultRoleConfig(store: Pick<...>) {
  ensurePlaygroundDocument(store);
  ensureStandardRoles(store, STANDARD_ROLE_SEEDS);
}
```

- [ ] **Step 4: Run the store test and verify it passes**

Run: `pnpm vitest run services/data-service/src/store.test.ts -t "seeds the five standard roles with documents and question sets"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/data-service/src/store.ts services/data-service/src/store.test.ts
git commit -m "feat: seed five standard default roles"
```

### Task 2: Add deterministic reset that clears old bot and role data while preserving playground

**Files:**
- Modify: `services/data-service/src/sqliteStore.ts`
- Modify: `services/data-service/src/store.ts`
- Test: `services/data-service/src/store.test.ts`
- Test: `services/data-service/src/sqliteStore.test.ts`

- [ ] **Step 1: Write failing reset tests for in-memory and SQLite stores**

```ts
it("resets bot and role data but preserves playground", () => {
  const store = createInMemoryDataStore();
  seedDefaultRoleConfig(store);
  const playgroundBefore = store.listGlobalDocuments().find((doc) => doc.slug === "playground");

  store.createBot({ bot_id: "bot-1", name: "old bot", runtime: "kiro", status: "ready" });
  store.resetToStandardRoleConfig();

  expect(store.listBots()).toEqual([]);
  expect(store.listRoles().map((role) => role.name)).toEqual([
    "产品经理",
    "测试工程师",
    "研发工程师",
    "市场人员",
    "运营人员",
  ]);
  expect(store.listGlobalDocuments().find((doc) => doc.slug === "playground")?.document_id).toBe(playgroundBefore?.document_id);
});
```

- [ ] **Step 2: Run the targeted reset tests and verify they fail**

Run: `pnpm vitest run services/data-service/src/store.test.ts services/data-service/src/sqliteStore.test.ts -t "resets bot and role data but preserves playground"`
Expected: FAIL because no reset helper exists yet.

- [ ] **Step 3: Implement `resetToStandardRoleConfig()` in both stores**

```ts
resetToStandardRoleConfig(): void {
  const playground = this.listGlobalDocuments().find((document) => document.slug === "playground");

  this.clearBotsAndRuntimeState();
  this.clearRoleConfigState();

  if (playground) {
    this.upsertGlobalDocument({
      document_id: playground.document_id,
      title: playground.title,
      slug: playground.slug,
      content: playground.content,
      enabled: true,
      sort_order: playground.sort_order,
    });
  }

  seedDefaultRoleConfig(this);
}
```

```ts
function clearBotsAndRuntimeState(db: Database) {
  db.prepare("delete from initialization_sessions").run();
  db.prepare("delete from pending_generated_documents").run();
  db.prepare("delete from conversations").run();
  db.prepare("delete from admins").run();
  db.prepare("delete from bot_channels").run();
  db.prepare("delete from bots").run();
}
```

- [ ] **Step 4: Run the reset tests and verify they pass**

Run: `pnpm vitest run services/data-service/src/store.test.ts services/data-service/src/sqliteStore.test.ts -t "resets bot and role data but preserves playground"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/data-service/src/store.ts services/data-service/src/sqliteStore.ts services/data-service/src/store.test.ts services/data-service/src/sqliteStore.test.ts
git commit -m "feat: add standard role reset flow"
```

### Task 3: Expose a reset entrypoint from data-service

**Files:**
- Modify: `services/data-service/src/server.ts`
- Test: `services/data-service/src/server.test.ts`

- [ ] **Step 1: Write the failing API test for the reset endpoint**

```ts
it("resets to the standard role configuration", async () => {
  const store = createInMemoryDataStore();
  seedDefaultRoleConfig(store);
  store.createBot({ bot_id: "old-bot", name: "Old Bot", runtime: "kiro", status: "ready" });

  const server = createDataServiceServer({ store });
  const response = await server.fetch(new Request("http://localhost/internal/reset-standard-role-config", { method: "POST" }));
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload.roles).toEqual(["产品经理", "测试工程师", "研发工程师", "市场人员", "运营人员"]);
  expect(store.listBots()).toEqual([]);
});
```

- [ ] **Step 2: Run the targeted server test and verify it fails**

Run: `pnpm vitest run services/data-service/src/server.test.ts -t "resets to the standard role configuration"`
Expected: FAIL because the endpoint does not exist.

- [ ] **Step 3: Add the reset route to `server.ts`**

```ts
if (request.method === "POST" && url.pathname === "/internal/reset-standard-role-config") {
  store.resetToStandardRoleConfig();
  return Response.json({
    ok: true,
    roles: store.listRoles().map((role) => role.name),
  });
}
```

- [ ] **Step 4: Run the server test and verify it passes**

Run: `pnpm vitest run services/data-service/src/server.test.ts -t "resets to the standard role configuration"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/data-service/src/server.ts services/data-service/src/server.test.ts
git commit -m "feat: add standard role reset endpoint"
```

### Task 4: Seed concrete hidden rule documents and best-practice question sets for all five roles

**Files:**
- Modify: `services/data-service/src/store.ts`
- Test: `services/data-service/src/store.test.ts`

- [ ] **Step 1: Write failing tests for representative role documents and question prompts**

```ts
it("seeds best-practice question sets for each standard role", () => {
  const store = createInMemoryDataStore();
  seedDefaultRoleConfig(store);

  const rolesBySlug = new Map(store.listRoles().map((role) => [role.slug, role]));

  const qaQuestions = store.listRoleQuestions(rolesBySlug.get("qa-engineer")!.role_id);
  expect(qaQuestions.map((question) => question.title)).toContain("默认输出更偏向哪类内容？");
  expect(qaQuestions.flatMap((question) => question.options_json.map((option) => option.label))).toContain("测试用例");

  const engineeringDocument = store.listRoleDocuments(rolesBySlug.get("engineer")!.role_id)[0];
  expect(engineeringDocument.content).toContain("兼容性");
  expect(engineeringDocument.content).toContain("回滚");
});
```

- [ ] **Step 2: Run the targeted role-content test and verify it fails**

Run: `pnpm vitest run services/data-service/src/store.test.ts -t "seeds best-practice question sets for each standard role"`
Expected: FAIL until the final content is seeded.

- [ ] **Step 3: Fill in the final documents and question sets in `store.ts`**

```ts
const STANDARD_ROLE_SEEDS = [
  {
    slug: "qa-engineer",
    name: "测试工程师",
    document: buildRoleDocument("测试工程师", `# Role: QA Engineer\n\n## 角色定位\n...\n## 默认工作规则\n- 优先从边界、异常流、兼容性、回归风险切入\n...`),
    questions: [
      buildQuestion("你希望它用什么方式和你交互？", ["逐句引导", "批量确认", "先给结论再展开"]),
      buildQuestion("是否需要长期沉淀规则和测试资产？", ["需要", "不需要"]),
      buildQuestion("默认输出更偏向哪类内容？", ["测试方案", "测试用例", "回归清单", "缺陷分析"]),
      buildQuestion("是否优先关注异常场景？", ["是", "否"]),
      buildQuestion("是否强调兼容性与回归？", ["是", "否"]),
      buildQuestion("是否有额外工作规则？", []),
    ],
  },
  // engineer, marketing, operations
];
```

- [ ] **Step 4: Run the role-content test and verify it passes**

Run: `pnpm vitest run services/data-service/src/store.test.ts -t "seeds best-practice question sets for each standard role"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/data-service/src/store.ts services/data-service/src/store.test.ts
git commit -m "feat: add standard role rule docs and questions"
```

### Task 5: Update control-api and bot-host expectations to the new role set

**Files:**
- Modify: `services/control-api/src/server.test.ts`
- Modify: `services/bot-host/src/server.test.ts`

- [ ] **Step 1: Write or update failing UI and initialization assertions for the five standard roles**

```ts
expect(html).toContain("产品经理");
expect(html).toContain("测试工程师");
expect(html).toContain("研发工程师");
expect(html).toContain("市场人员");
expect(html).toContain("运营人员");
expect(html).toContain("默认输出更偏向哪类内容？");
```

```ts
expect(replyText).toContain("产品经理");
expect(replyText).toContain("测试工程师");
expect(replyText).toContain("研发工程师");
expect(replyText).toContain("市场人员");
expect(replyText).toContain("运营人员");
```

- [ ] **Step 2: Run the focused tests and verify they fail on old expectations**

Run: `pnpm vitest run services/control-api/src/server.test.ts services/bot-host/src/server.test.ts`
Expected: FAIL on outdated role names or seeded question text.

- [ ] **Step 3: Update fixtures and expectations to the new standard role set**

```ts
const roles = [
  { role_id: "role-product-manager", name: "产品经理", slug: "product-manager", enabled: true },
  { role_id: "role-qa-engineer", name: "测试工程师", slug: "qa-engineer", enabled: true },
  { role_id: "role-engineer", name: "研发工程师", slug: "engineer", enabled: true },
  { role_id: "role-marketing", name: "市场人员", slug: "marketing", enabled: true },
  { role_id: "role-operations", name: "运营人员", slug: "operations", enabled: true },
];
```

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm vitest run services/control-api/src/server.test.ts services/bot-host/src/server.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/control-api/src/server.test.ts services/bot-host/src/server.test.ts
git commit -m "test: align UI and initialization with standard roles"
```

### Task 6: Document and verify the reset in the running environment

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write the failing expectation as a verification checklist in the README diff**

```md
## 默认角色集

启动默认环境后，系统会重建为以下标准角色：
- 产品经理
- 测试工程师
- 研发工程师
- 市场人员
- 运营人员
```

- [ ] **Step 2: Update the README with the standard role behavior**

```md
当前默认环境会清理旧角色与旧 bot 运行数据，并写入 5 个标准角色题库。`playground.md` 保留不动，角色规则与引导问题可继续在 WebUI 中微调。
```

- [ ] **Step 3: Run the full verification suite**

Run: `pnpm vitest run services/data-service/src/store.test.ts services/data-service/src/sqliteStore.test.ts services/data-service/src/server.test.ts services/control-api/src/server.test.ts services/bot-host/src/server.test.ts`
Expected: PASS

- [ ] **Step 4: Run typecheck and diff check**

Run: `pnpm run typecheck && git diff --check`
Expected: PASS

- [ ] **Step 5: Rebuild the local stack and verify the reset endpoint plus role list**

Run:
```bash
./scripts/dev-redeploy.sh
curl -X POST http://localhost:8300/internal/reset-standard-role-config
curl http://localhost:8300/v1/roles
```
Expected:
- reset returns `{ "ok": true, "roles": [...] }`
- roles list contains exactly the five standard roles

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: describe standard role set reset"
```

---

## Self-Review

- Spec coverage: this plan covers seed replacement, runtime reset, API exposure, seeded content, UI expectation alignment, and runtime verification.
- Placeholder scan: removed generic TODO language; every task includes concrete code, files, and commands.
- Type consistency: uses existing `role.md`, `role_questions`, `seedDefaultRoleConfig`, and WebUI role APIs consistently across tasks.
