#!/usr/bin/env bash
set -euo pipefail

bot_name="${1:-example-bot}"
config_path="bots/${bot_name}/workspace/private/bot.config.yaml"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template_dir="$(cd "${script_dir}/.." && pwd)"

echo "Checking base runtime..."
node --version
npm --version

if [ ! -f "${config_path}" ]; then
  echo "Missing ${config_path}" >&2
  exit 1
fi

read_config() {
  node -e '
    const fs = require("fs");
    const { createRequire } = require("module");
    const requireFromTemplate = createRequire(process.argv[2] + "/package.json");
    const YAML = requireFromTemplate("yaml");
    const config = YAML.parse(fs.readFileSync(process.argv[1], "utf8"));
    const value = process.argv[3].split(".").reduce((current, key) => current?.[key], config);
    if (typeof value === "string") {
      console.log(value);
    }
  ' "${config_path}" "${template_dir}" "$1"
}

provider="$(read_config "cli.provider")"
command_name="$(read_config "cli.command")"
kiro_host_auth_dir="$(read_config "cli.env.KIRO_HOST_AUTH_DIR")"

echo "Checking CLI provider: ${provider}"
if [ "${provider}" != "kiro-cli" ]; then
  echo "Unsupported CLI provider: ${provider}. This template supports only kiro-cli." >&2
  exit 1
fi

if ! command -v "${command_name}" >/dev/null 2>&1; then
  echo "Missing CLI command: ${command_name}" >&2
  echo "Install the selected CLI in Dockerfile or on the host, then rerun this check." >&2
  exit 1
fi

if [ -n "${kiro_host_auth_dir}" ]; then
  echo "Checking configured Kiro host auth directory..."
  if [ ! -d "${kiro_host_auth_dir}" ]; then
    echo "Missing configured Kiro host auth directory." >&2
    exit 1
  fi
fi

"${command_name}" --version
echo "Runtime check completed."
