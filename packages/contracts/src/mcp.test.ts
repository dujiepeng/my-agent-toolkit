import { describe, expect, it } from "vitest";
import {
  isReservedConfigDocumentTitle,
  parseDocumentCreateInput,
  parseMcpScope,
  parseMcpTier,
  parseTrustedMcpContext,
  signRunnerToken,
  verifyRunnerToken,
} from "./mcp.js";

describe("parseTrustedMcpContext", () => {
  it("accepts a valid trusted MCP context", () => {
    const context = parseTrustedMcpContext({
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
    });

    expect(context).toEqual({
      bot_id: "prd-bot",
      user_id: "user-a",
      conversation_id: "conv-1",
      runtime: "kiro",
    });
  });

  it("rejects empty trusted context ids", () => {
    expect(() =>
      parseTrustedMcpContext({
        bot_id: " ",
        user_id: "user-a",
        conversation_id: "conv-1",
        runtime: "kiro",
      })
    ).toThrow("bot_id is required");
    expect(() =>
      parseTrustedMcpContext({
        bot_id: "prd-bot",
        user_id: "",
        conversation_id: "conv-1",
        runtime: "kiro",
      })
    ).toThrow("user_id is required");
    expect(() =>
      parseTrustedMcpContext({
        bot_id: "prd-bot",
        user_id: "user-a",
        conversation_id: "",
        runtime: "kiro",
      })
    ).toThrow("conversation_id is required");
  });
});

describe("runner token signing", () => {
  const secret = "test-runner-secret";
  const context = {
    bot_id: "prd-bot",
    user_id: "user-a",
    conversation_id: "conv-1",
    runtime: "kiro" as const,
  };

  it("signs and verifies a trusted MCP context", () => {
    const token = signRunnerToken(secret, context);

    expect(verifyRunnerToken(secret, token, {
      bot_id: "prd-bot",
      conversation_id: "conv-1",
    })).toEqual(context);
  });

  it("rejects tokens that do not match the requested path context", () => {
    const token = signRunnerToken(secret, context);

    expect(() => verifyRunnerToken(secret, token, {
      bot_id: "other-bot",
      conversation_id: "conv-1",
    })).toThrow("runner token context does not match request path");
  });

  it("rejects malformed or wrongly signed tokens", () => {
    const token = signRunnerToken(secret, context);

    expect(() => verifyRunnerToken("wrong-secret", token, {
      bot_id: "prd-bot",
      conversation_id: "conv-1",
    })).toThrow("runner token signature is invalid");
    expect(() => verifyRunnerToken(secret, "not-a-token", {
      bot_id: "prd-bot",
      conversation_id: "conv-1",
    })).toThrow("runner token is invalid");
  });
});

describe("parseMcpScope", () => {
  it("accepts supported MCP scopes", () => {
    expect(parseMcpScope("system")).toBe("system");
    expect(parseMcpScope("shared")).toBe("shared");
    expect(parseMcpScope("bot")).toBe("bot");
    expect(parseMcpScope("user")).toBe("user");
    expect(parseMcpScope("session")).toBe("session");
  });

  it("rejects unsupported MCP scopes", () => {
    expect(() => parseMcpScope("namespace")).toThrow(
      "scope must be system, shared, bot, user, or session",
    );
  });
});

describe("parseMcpTier", () => {
  it("accepts supported MCP tiers", () => {
    expect(parseMcpTier("core")).toBe("core");
    expect(parseMcpTier("reference")).toBe("reference");
    expect(parseMcpTier("temp")).toBe("temp");
  });

  it("rejects unsupported MCP tiers", () => {
    expect(() => parseMcpTier("archive")).toThrow(
      "tier must be core, reference, or temp",
    );
  });
});

describe("parseDocumentCreateInput", () => {
  it("accepts a valid document create input", () => {
    const input = parseDocumentCreateInput({
      scope: "bot",
      owner_id: "prd-bot",
      title: "语音转文字 API PRD",
      doc_type: "prd",
      content: "# PRD",
      tags: ["prd", "asr"],
      visibility: "bot",
      tier: "core",
    });

    expect(input).toEqual({
      scope: "bot",
      owner_id: "prd-bot",
      title: "语音转文字 API PRD",
      doc_type: "prd",
      content: "# PRD",
      tags: ["prd", "asr"],
      visibility: "bot",
      tier: "core",
    });
  });

  it("rejects reserved config document titles", () => {
    for (const title of ["soul", "soul.md", "agents", "agents.md", "AGENTS.md"]) {
      expect(() =>
        parseDocumentCreateInput({
          scope: "bot",
          owner_id: "prd-bot",
          title,
          doc_type: "config",
          content: "not allowed",
        })
      ).toThrow("document title is reserved for bot configuration");
    }
  });
});

describe("isReservedConfigDocumentTitle", () => {
  it("detects reserved config document titles case-insensitively", () => {
    expect(isReservedConfigDocumentTitle("soul")).toBe(true);
    expect(isReservedConfigDocumentTitle(" Soul.md ")).toBe(true);
    expect(isReservedConfigDocumentTitle("AGENTS.md")).toBe(true);
    expect(isReservedConfigDocumentTitle("Product PRD")).toBe(false);
  });
});
