export type McpScope = "system" | "shared" | "bot" | "user" | "session";
export type McpTier = "core" | "reference" | "temp";
export type McpRuntime = "mock" | "kiro";

export interface TrustedMcpContext {
  bot_id: string;
  user_id: string;
  conversation_id: string;
  runtime: McpRuntime;
}

export interface DocumentCreateInput {
  scope: McpScope;
  owner_id: string;
  title: string;
  doc_type: string;
  content: string;
  tags?: string[];
  visibility?: "private" | "bot" | "shared";
  tier?: McpTier;
  source_type?: string;
  source_uri?: string;
  created_by_bot_id?: string;
  created_by_user_id?: string;
}

const MCP_SCOPES = ["system", "shared", "bot", "user", "session"] as const;
const MCP_TIERS = ["core", "reference", "temp"] as const;
const MCP_RUNTIMES = ["mock", "kiro"] as const;
const RESERVED_CONFIG_DOCUMENT_TITLES = new Set([
  "soul",
  "soul.md",
  "agents",
  "agents.md",
]);

export function parseTrustedMcpContext(value: unknown): TrustedMcpContext {
  const record = requireRecord(value, "trusted MCP context");
  return {
    bot_id: readRequiredString(record, "bot_id").trim(),
    user_id: readRequiredString(record, "user_id").trim(),
    conversation_id: readRequiredString(record, "conversation_id").trim(),
    runtime: parseMcpRuntime(record.runtime),
  };
}

export function parseDocumentCreateInput(value: unknown): DocumentCreateInput {
  const record = requireRecord(value, "document create input");
  const title = readRequiredString(record, "title").trim();
  if (isReservedConfigDocumentTitle(title)) {
    throw new Error("document title is reserved for bot configuration");
  }

  return {
    scope: parseMcpScope(record.scope),
    owner_id: readRequiredString(record, "owner_id").trim(),
    title,
    doc_type: readRequiredString(record, "doc_type").trim(),
    content: readRequiredString(record, "content"),
    ...(record.tags !== undefined ? { tags: parseStringArray(record.tags, "tags") } : {}),
    ...(record.visibility !== undefined
      ? { visibility: parseDocumentVisibility(record.visibility) }
      : {}),
    ...(record.tier !== undefined ? { tier: parseMcpTier(record.tier) } : {}),
    ...(record.source_type !== undefined
      ? { source_type: readRequiredString(record, "source_type").trim() }
      : {}),
    ...(record.source_uri !== undefined
      ? { source_uri: readRequiredString(record, "source_uri").trim() }
      : {}),
    ...(record.created_by_bot_id !== undefined
      ? { created_by_bot_id: readRequiredString(record, "created_by_bot_id").trim() }
      : {}),
    ...(record.created_by_user_id !== undefined
      ? { created_by_user_id: readRequiredString(record, "created_by_user_id").trim() }
      : {}),
  };
}

export function parseMcpScope(value: unknown): McpScope {
  if (isOneOf(value, MCP_SCOPES)) {
    return value;
  }
  throw new Error("scope must be system, shared, bot, user, or session");
}

export function parseMcpTier(value: unknown): McpTier {
  if (isOneOf(value, MCP_TIERS)) {
    return value;
  }
  throw new Error("tier must be core, reference, or temp");
}

export function isReservedConfigDocumentTitle(value: string): boolean {
  return RESERVED_CONFIG_DOCUMENT_TITLES.has(value.trim().toLowerCase());
}

function parseMcpRuntime(value: unknown): McpRuntime {
  if (isOneOf(value, MCP_RUNTIMES)) {
    return value;
  }
  throw new Error("runtime must be mock or kiro");
}

function parseDocumentVisibility(value: unknown): "private" | "bot" | "shared" {
  if (value === "private" || value === "bot" || value === "shared") {
    return value;
  }
  throw new Error("visibility must be private, bot, or shared");
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`${field} must be an array of strings`);
    }
    return item.trim();
  });
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value;
}

function isOneOf<T extends readonly string[]>(
  value: unknown,
  options: T,
): value is T[number] {
  return typeof value === "string" && options.includes(value);
}
