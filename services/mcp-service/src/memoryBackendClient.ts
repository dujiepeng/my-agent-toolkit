import type { McpScope, McpTier } from "@my-agent-toolkit/contracts";

export interface MemoryBackendClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export interface StoreMemoryBackendInput {
  scope: McpScope;
  owner_id: string;
  content: string;
  tags?: string[];
  tier?: McpTier;
  source_type?: string;
}

export interface SearchBackendInput {
  query: string;
  scopes: McpScope[];
  owner_ids: string[];
  sources?: Array<"documents" | "memories">;
  tags?: string[];
  limit?: number;
}

export interface MemoryBackendClient {
  storeMemory(input: StoreMemoryBackendInput): Promise<Record<string, unknown>>;
  search(input: SearchBackendInput): Promise<Record<string, unknown>>;
}

export function createMemoryBackendClient(
  options: MemoryBackendClientOptions,
): MemoryBackendClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  return {
    async storeMemory(input) {
      return requestJson(fetchImpl, `${baseUrl}/internal/v1/memories`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
    },

    async search(input) {
      return requestJson(fetchImpl, `${baseUrl}/internal/v1/memories/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
    },
  };
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "string"
      ? body.error
      : `memory backend request failed: ${response.status}`;
    throw new Error(message);
  }
  return body;
}
