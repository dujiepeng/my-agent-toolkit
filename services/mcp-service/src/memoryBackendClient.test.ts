import { describe, expect, it } from "vitest";
import { createMemoryBackendClient } from "./memoryBackendClient.js";

describe("memory backend client", () => {
  it("stores scoped memory chunks through the internal memory backend", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = createMemoryBackendClient({
      baseUrl: "http://memory-service:8100",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({
          backend_memory_id: "vec-1",
          chunks: 2,
        }, 201);
      },
    });

    const result = await client.storeMemory({
      scope: "user",
      owner_id: "user-a",
      content: "用户关注环信 IM 产品和 PRD 质量。",
      tags: ["user-profile"],
      tier: "core",
      source_type: "text",
    });

    expect(result).toEqual({
      backend_memory_id: "vec-1",
      chunks: 2,
    });
    expect(calls[0].url).toBe("http://memory-service:8100/internal/v1/memories");
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      scope: "user",
      owner_id: "user-a",
      content: "用户关注环信 IM 产品和 PRD 质量。",
    });
  });

  it("searches scoped memory through the internal memory backend", async () => {
    const client = createMemoryBackendClient({
      baseUrl: "http://memory-service:8100",
      fetch: async (url, init) => {
        expect(String(url)).toBe("http://memory-service:8100/internal/v1/memories/search");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          query: "PRD 质量",
          scopes: ["user"],
          owner_ids: ["user-a"],
        });
        return jsonResponse({
          results: [
            {
              source: "memory",
              id: "mem-1",
              snippet: "用户关注 PRD 质量。",
              score: 0.91,
              metadata: {
                tier: "core",
              },
            },
          ],
        });
      },
    });

    await expect(client.search({
      query: "PRD 质量",
      scopes: ["user"],
      owner_ids: ["user-a"],
      limit: 5,
    })).resolves.toEqual({
      results: [
        {
          source: "memory",
          id: "mem-1",
          snippet: "用户关注 PRD 质量。",
          score: 0.91,
          metadata: {
            tier: "core",
          },
        },
      ],
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
