import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const templateRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(templateRoot, "scripts", "check-runtime.sh");

function makeTempRoot(options: {
  provider?: string;
  command?: string;
  authDir?: string;
  fakeCommand?: {
    name?: string;
    versionExitCode?: number;
  };
} = {}): { root: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-runtime-"));
  const privateDir = path.join(root, "bots", "demo", "workspace", "private");
  fs.mkdirSync(privateDir, { recursive: true });

  const provider = options.provider ?? "kiro-cli";
  const command = options.command ?? "kiro-cli";
  const authDir = options.authDir;
  const envLines = authDir ? [`    KIRO_HOST_AUTH_DIR: "${authDir}"`] : [];
  fs.writeFileSync(
    path.join(privateDir, "bot.config.yaml"),
    [
      "cli:",
      `  provider: ${provider}`,
      `  command: ${command}`,
      "  env:",
      ...envLines
    ].join("\n")
  );

  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  if (options.fakeCommand) {
    const commandName = options.fakeCommand.name ?? command;
    const exitCode = options.fakeCommand.versionExitCode ?? 0;
    const commandPath = path.join(binDir, commandName);
    fs.writeFileSync(
      commandPath,
      `#!/usr/bin/env bash\nif [ "\${1:-}" = "--version" ]; then exit ${exitCode}; fi\nexit 0\n`,
      { mode: 0o755 }
    );
  }

  return {
    root,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`
    }
  };
}

function runCheck(root: string, env: NodeJS.ProcessEnv) {
  return spawnSync(scriptPath, ["demo"], {
    cwd: root,
    env,
    encoding: "utf8"
  });
}

test("passes for provider kiro-cli when command exists and version succeeds", () => {
  const { root, env } = makeTempRoot({ fakeCommand: { versionExitCode: 0 } });

  const result = runCheck(root, env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Runtime check completed\./);
});

test("fails for unsupported provider codex", () => {
  const { root, env } = makeTempRoot({
    provider: "codex",
    command: "codex",
    fakeCommand: { name: "codex", versionExitCode: 0 }
  });

  const result = runCheck(root, env);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported CLI provider: codex/);
});

test("fails when configured command is missing", () => {
  const { root, env } = makeTempRoot({ command: "missing-kiro-cli" });

  const result = runCheck(root, env);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing CLI command: missing-kiro-cli/);
});

test("fails when command version exits nonzero", () => {
  const { root, env } = makeTempRoot({ fakeCommand: { versionExitCode: 42 } });

  const result = runCheck(root, env);

  assert.equal(result.status, 42);
});

test("fails when configured Kiro host auth directory is missing", () => {
  const missingAuthDir = path.join(os.tmpdir(), "missing-kiro-auth-dir");
  const { root, env } = makeTempRoot({
    authDir: missingAuthDir,
    fakeCommand: { versionExitCode: 0 }
  });

  const result = runCheck(root, env);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing configured Kiro host auth directory/);
});
