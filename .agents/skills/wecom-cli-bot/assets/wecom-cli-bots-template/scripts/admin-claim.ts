import path from "node:path";
import { fileURLToPath } from "node:url";
import { AdminStore, generateClaimCode } from "../src/admin/adminStore.js";

const INVALID_BOT_NAME_ERROR = "Invalid bot name. Use only letters, numbers, dot, underscore, or hyphen.";

export type AdminClaimResult = {
  ok: boolean;
  code: string;
  error?: string;
};

export function runAdminClaim(
  argv: string[],
  rootDir = process.cwd(),
  writeLine: (line: string) => void = console.log
): AdminClaimResult {
  const bot = valueAfter(argv, "--bot");
  const reset = argv.includes("--reset");
  if (!bot) {
    return { ok: false, code: "", error: "Usage: npm run admin:claim -- --bot <bot-name> [--reset]" };
  }
  if (!isValidBotName(bot)) {
    return { ok: false, code: "", error: INVALID_BOT_NAME_ERROR };
  }

  const botsRoot = path.resolve(rootDir, "bots");
  const botRoot = path.resolve(botsRoot, bot);
  if (!isPathInside(botRoot, botsRoot)) {
    return { ok: false, code: "", error: INVALID_BOT_NAME_ERROR };
  }

  const privateDir = path.join(botRoot, "workspace", "private");
  const store = new AdminStore(privateDir);
  const state = store.read();
  if (state.admin_user_id && !reset) {
    return {
      ok: false,
      code: "",
      error: "Bot already has an administrator. Use --reset to generate a new claim code."
    };
  }

  const code = generateClaimCode();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (reset) {
    store.resetWithClaim(code, expiresAt);
  } else {
    store.writeClaim(code, expiresAt);
  }

  writeLine(`Admin claim code generated for bot: ${bot}`);
  writeLine("Send this message to the bot in Enterprise WeChat:");
  writeLine(`/claim_admin ${code}`);
  writeLine(`Expires at: ${expiresAt.toISOString()}`);
  return { ok: true, code };
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function isValidBotName(bot: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(bot) && !bot.startsWith("-");
}

function isPathInside(target: string, parent: string): boolean {
  const relative = path.relative(parent, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = runAdminClaim(process.argv.slice(2));
  if (!result.ok) {
    console.error(result.error);
    process.exitCode = 1;
  }
}
