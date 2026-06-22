import { WSClient } from "@wecom/aibot-node-sdk";

export interface WeComVerifier {
  verify(input: {
    bot_id: string;
    secret: string;
    timeout_ms?: number;
  }): Promise<{ verified: true } | { verified: false; error: string }>;
}

export function createWeComSdkVerifier(): WeComVerifier {
  return {
    verify(input) {
      return verifyWithSdk(input);
    },
  };
}

async function verifyWithSdk(input: {
  bot_id: string;
  secret: string;
  timeout_ms?: number;
}): Promise<{ verified: true } | { verified: false; error: string }> {
  const timeoutMs = input.timeout_ms ?? 8000;
  let client: WSClient | undefined;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { verified: true } | { verified: false; error: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      client?.disconnect();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ verified: false, error: "wecom verification timed out" });
    }, timeoutMs);

    try {
      client = new WSClient({
        botId: input.bot_id,
        secret: input.secret,
        maxReconnectAttempts: 0,
        maxAuthFailureAttempts: 1,
        heartbeatInterval: 30_000,
        logger: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      });

      client.on("authenticated", () => {
        finish({ verified: true });
      });
      client.on("error", (error: Error) => {
        finish({
          verified: false,
          error: error.message || "wecom verification failed",
        });
      });
      client.connect();
    } catch (error) {
      finish({
        verified: false,
        error: error instanceof Error ? error.message : "wecom verification failed",
      });
    }
  });
}
