import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { RuntimeName } from "@my-agent-toolkit/contracts";
import type { RunnerConfig } from "./config.js";

export interface RuntimeStatus {
  runtime: RuntimeName;
  enabled: boolean;
  configured: boolean;
  available: boolean;
  error?: string;
}

export async function getRuntimeStatuses(
  config: RunnerConfig,
): Promise<RuntimeStatus[]> {
  const statuses: RuntimeStatus[] = [];

  if (config.enabled_runtimes.includes("mock")) {
    statuses.push({
      runtime: "mock",
      enabled: true,
      configured: true,
      available: true,
    });
  }

  if (config.enabled_runtimes.includes("kiro")) {
    statuses.push(await getKiroStatus(config));
  }

  return statuses;
}

async function getKiroStatus(config: RunnerConfig): Promise<RuntimeStatus> {
  if (!config.kiro) {
    return {
      runtime: "kiro",
      enabled: true,
      configured: false,
      available: false,
      error: "kiro runtime is missing configuration",
    };
  }

  if (config.kiro.command.includes("/")) {
    try {
      await access(config.kiro.command, constants.X_OK);
    } catch {
      return {
        runtime: "kiro",
        enabled: true,
        configured: true,
        available: false,
        error: `command not found: ${config.kiro.command}`,
      };
    }
  }

  return {
    runtime: "kiro",
    enabled: true,
    configured: true,
    available: true,
  };
}
