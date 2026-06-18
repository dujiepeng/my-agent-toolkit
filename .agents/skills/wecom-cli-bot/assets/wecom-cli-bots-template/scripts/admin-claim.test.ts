import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAdminClaim } from "./admin-claim.js";

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "admin-claim-"));
  fs.mkdirSync(path.join(root, "bots", "demo", "workspace", "private"), { recursive: true });
  return root;
}

test("runAdminClaim creates a claim without storing the plain code", () => {
  const root = tempRoot();
  const output: string[] = [];

  const result = runAdminClaim(["--bot", "demo"], root, (line) => output.push(line));

  assert.equal(result.ok, true);
  assert.match(output.join("\n"), /\/claim_admin /);
  const stateText = fs.readFileSync(path.join(root, "bots", "demo", "workspace", "private", "admin.json"), "utf8");
  assert.doesNotMatch(stateText, new RegExp(result.code));
  assert.match(stateText, /sha256:/);
});

test("runAdminClaim refuses to overwrite an existing admin without reset", () => {
  const root = tempRoot();
  runAdminClaim(["--bot", "demo"], root, () => {});
  const adminPath = path.join(root, "bots", "demo", "workspace", "private", "admin.json");
  const state = JSON.parse(fs.readFileSync(adminPath, "utf8"));
  state.admin_user_id = "admin";
  state.status = "ready";
  fs.writeFileSync(adminPath, JSON.stringify(state));

  const result = runAdminClaim(["--bot", "demo"], root, () => {});

  assert.equal(result.ok, false);
  assert.equal(result.error, "Bot already has an administrator. Use --reset to generate a new claim code.");
});

test("runAdminClaim reset clears admin and creates a fresh claim", () => {
  const root = tempRoot();
  const first = runAdminClaim(["--bot", "demo"], root, () => {});
  const adminPath = path.join(root, "bots", "demo", "workspace", "private", "admin.json");
  const existingState = JSON.parse(fs.readFileSync(adminPath, "utf8"));
  existingState.admin_user_id = "admin";
  existingState.status = "ready";
  fs.writeFileSync(adminPath, JSON.stringify(existingState));

  const reset = runAdminClaim(["--bot", "demo", "--reset"], root, () => {});

  const stateText = fs.readFileSync(adminPath, "utf8");
  const state = JSON.parse(stateText);
  assert.equal(reset.ok, true);
  assert.notEqual(reset.code, first.code);
  assert.equal(state.admin_user_id, null);
  assert.equal(state.status, "unclaimed");
  assert.match(state.claim.code_hash, /^sha256:/);
  assert.doesNotMatch(stateText, new RegExp(reset.code));
});

test("runAdminClaim rejects traversal bot names without writing escaped admin state", () => {
  const root = tempRoot();
  const result = runAdminClaim(["--bot", "../../escape"], root, () => {});

  assert.equal(result.ok, false);
  assert.equal(result.error, "Invalid bot name. Use only letters, numbers, dot, underscore, or hyphen.");
  assert.equal(fs.existsSync(path.resolve(root, "..", "..", "escape", "workspace", "private", "admin.json")), false);
});

test("runAdminClaim rejects absolute path bot names without writing admin state", () => {
  const root = tempRoot();
  const bot = path.join(path.parse(root).root, "tmp", "escape");
  const result = runAdminClaim(["--bot", bot], root, () => {});

  assert.equal(result.ok, false);
  assert.equal(result.error, "Invalid bot name. Use only letters, numbers, dot, underscore, or hyphen.");
  assert.equal(fs.existsSync(path.join(bot, "workspace", "private", "admin.json")), false);
});

test("runAdminClaim rejects flag-like bot names without writing admin state", () => {
  const root = tempRoot();
  const result = runAdminClaim(["--bot", "--reset"], root, () => {});

  assert.equal(result.ok, false);
  assert.equal(result.error, "Invalid bot name. Use only letters, numbers, dot, underscore, or hyphen.");
  assert.equal(fs.existsSync(path.join(root, "bots", "--reset", "workspace", "private", "admin.json")), false);
});
