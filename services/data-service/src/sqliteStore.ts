import Database from "better-sqlite3";
import {
  ADMIN_CLAIM_TTL_MS,
  buildWeComConnectionTestResult,
  configDocumentOrder,
  hashClaimCode,
  isBotConfigDocumentTitle,
  nextIsoTimestamp,
  optionalText,
  requireBotConfigDocumentTitle,
  requireBotStatus,
  requireText,
  type AdminClaimRecord,
  type AdminRecord,
  type BotChannelDetail,
  type BotConfigDocumentRecord,
  type BotChannelRecord,
  type BotRecord,
  type ClaimAdminInput,
  type ConversationRecord,
  type DataStore,
  type ListCurrentMemoryDocumentsInput,
  type MemoryDocumentRecord,
  type ResolveConversationInput,
  type TransferAdminInput,
  type UpsertMemoryDocumentInput,
  type UpsertBotConfigDocumentInput,
  type CreateBotInput,
  type DataStoreOptions,
  type UpdateBotInput,
  type WeComRuntimeBotConfig,
} from "./store.js";

export function createSqliteDataStore(
  dbPath: string,
  options: DataStoreOptions = {},
): DataStore {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  migrate(db);

  return {
    createBot(input) {
      const now = new Date().toISOString();
      const wecomSecret = optionalText(input.wecom_secret);
      const wecomBotId = optionalText(input.wecom_bot_id);
      assertUniqueWeComBotId(db, wecomBotId);
      const bot: BotRecord = {
        bot_id: requireText(input.bot_id, "bot_id"),
        name: requireText(input.name, "name"),
        runtime: requireText(input.runtime, "runtime"),
        status: "draft",
        wecom_bot_id: wecomBotId,
        wecom_secret_configured: Boolean(wecomSecret),
        wecom_connection_status: "unchecked",
        created_at: now,
        updated_at: now,
      };
      db.prepare(
        "insert into bots (bot_id, name, runtime, status, wecom_bot_id, wecom_secret, wecom_connection_status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        bot.bot_id,
        bot.name,
        bot.runtime,
        bot.status,
        bot.wecom_bot_id ?? null,
        wecomSecret ?? null,
        bot.wecom_connection_status,
        bot.created_at,
        bot.updated_at,
      );
      return bot;
    },

    getBot(botId) {
      return mapBotRecord(
        db.prepare("select * from bots where bot_id = ?").get(botId),
      );
    },

    listBots() {
      return db
        .prepare("select * from bots order by rowid asc")
        .all()
        .map(mapBotRecord)
        .filter((bot): bot is BotRecord => Boolean(bot));
    },

    updateBot(botId, input) {
      return updateBot(db, botId, input);
    },

    listBotChannels(botId) {
      const rows = botId
        ? [getRequiredBot(db, botId)]
        : db
          .prepare("select * from bots order by rowid asc")
          .all()
          .map(mapBotRecord)
          .filter((bot): bot is BotRecord => Boolean(bot));
      return rows.map(botToChannelRecord);
    },

    getBotChannelDetail(botId) {
      return getBotChannelDetail(db, botId);
    },

    resetAdminClaim(botId) {
      const bot = getRequiredBot(db, botId);
      db.prepare("delete from admins where bot_id = ?").run(bot.bot_id);
      db.prepare("delete from admin_claims where bot_id = ?").run(bot.bot_id);
      return this.createAdminClaim(bot.bot_id);
    },

    resetBot(botId) {
      const bot = getRequiredBot(db, botId);
      const admin = db.prepare("select * from admins where bot_id = ?").get(bot.bot_id);
      const status = admin ? "initializing" : "draft";
      const updatedAt = nextIsoTimestamp(bot.updated_at);
      db.prepare("update bots set status = ?, updated_at = ? where bot_id = ?").run(
        status,
        updatedAt,
        bot.bot_id,
      );
      return { ...bot, status, updated_at: updatedAt };
    },

    deleteBotChannel(botId) {
      const bot = getRequiredBot(db, botId);
      const updatedAt = nextIsoTimestamp(bot.updated_at);
      db.prepare(
        "update bots set wecom_bot_id = null, wecom_secret = null, wecom_connection_status = ?, last_wecom_check_at = null, last_wecom_error = null, updated_at = ? where bot_id = ?",
      ).run("unchecked", updatedAt, bot.bot_id);
      return botToChannelRecord({
        ...bot,
        wecom_bot_id: undefined,
        wecom_secret_configured: false,
        wecom_connection_status: "unchecked",
        last_wecom_check_at: undefined,
        last_wecom_error: undefined,
        updated_at: updatedAt,
      });
    },

    listWeComRuntimeBots() {
      return db.prepare(
        `
          select bot_id, runtime, wecom_bot_id, wecom_secret
          from bots
          where wecom_bot_id is not null
            and wecom_secret is not null
          order by rowid asc
        `,
      ).all() as WeComRuntimeBotConfig[];
    },

    async testWeComConnection(botId) {
      return testWeComConnection(db, botId, options);
    },

    getAdmin(botId) {
      return db.prepare("select * from admins where bot_id = ?").get(botId) as
        | AdminRecord
        | undefined;
    },

    createAdminClaim(botId) {
      const bot = getRequiredBot(db, botId);
      const existingAdmin = db
        .prepare("select * from admins where bot_id = ?")
        .get(bot.bot_id);
      if (existingAdmin) {
        throw new Error(`admin already claimed for bot: ${bot.bot_id}`);
      }

      const code = String(
        crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000,
      ).padStart(6, "0");
      const now = new Date();
      const claim: AdminClaimRecord = {
        bot_id: bot.bot_id,
        code,
        code_hash: hashClaimCode(code),
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ADMIN_CLAIM_TTL_MS).toISOString(),
      };

      db.prepare(
        "insert or replace into admin_claims (bot_id, code_hash, created_at, expires_at) values (?, ?, ?, ?)",
      ).run(claim.bot_id, claim.code_hash, claim.created_at, claim.expires_at);
      return claim;
    },

    claimAdmin(input) {
      return claimAdmin(db, input);
    },

    verifyAdminClaim(input) {
      const claim = db
        .prepare("select * from admin_claims where bot_id = ?")
        .get(input.bot_id) as
        | Omit<AdminClaimRecord, "code">
        | undefined;
      if (!claim) {
        throw new Error(
          `admin claim code does not exist for bot: ${input.bot_id}`,
        );
      }
      if (new Date(claim.expires_at).getTime() < Date.now()) {
        throw new Error("admin claim code expired");
      }
      if (claim.code_hash !== hashClaimCode(input.code)) {
        throw new Error("invalid admin claim code");
      }

      const admin = claimAdmin(db, input);
      db.prepare("delete from admin_claims where bot_id = ?").run(input.bot_id);
      return admin;
    },

    transferAdmin(input) {
      return transferAdmin(db, input);
    },

    markBotReady(botId) {
      const bot = getRequiredBot(db, botId);
      const admin = db.prepare("select * from admins where bot_id = ?").get(botId);
      if (!admin) {
        throw new Error(`admin is not claimed for bot: ${botId}`);
      }
      const updatedAt = new Date().toISOString();
      db.prepare("update bots set status = ?, updated_at = ? where bot_id = ?").run(
        "ready",
        updatedAt,
        botId,
      );
      return { ...bot, status: "ready", updated_at: updatedAt };
    },

    resolveMessageContext(input) {
      const bot = getRequiredBot(db, input.bot_id);
      const admin = db
        .prepare("select * from admins where bot_id = ?")
        .get(input.bot_id) as AdminRecord | undefined;
      const isAdmin = admin?.wecom_user_id === input.wecom_user_id;

      if (!admin) {
        return {
          bot_id: bot.bot_id,
          wecom_user_id: input.wecom_user_id,
          is_admin: false,
          allowed: false,
          reason: "admin_unclaimed",
        };
      }

      if (bot.status !== "ready") {
        if (isAdmin) {
          return {
            bot_id: bot.bot_id,
            wecom_user_id: input.wecom_user_id,
            is_admin: true,
            allowed: true,
            reason: "initializing",
            conversation: resolveConversation(db, { ...input, purpose: "init" }),
          };
        }

        return {
          bot_id: bot.bot_id,
          wecom_user_id: input.wecom_user_id,
          is_admin: false,
          allowed: false,
          reason: "initialization_required",
        };
      }

      return {
        bot_id: bot.bot_id,
        wecom_user_id: input.wecom_user_id,
        is_admin: isAdmin,
        allowed: true,
        reason: "ready",
        conversation: resolveConversation(db, input),
      };
    },

    resolveConversation(input) {
      return resolveConversation(db, input);
    },

    upsertBotConfigDocument(input) {
      return upsertBotConfigDocument(db, input);
    },

    listBotConfigDocuments(botId) {
      return listBotConfigDocuments(db, botId);
    },

    upsertMemoryDocument(input) {
      if (input.scope === "bot" && isBotConfigDocumentTitle(input.title)) {
        throw new Error("bot config documents must use /v1/bot-config-documents");
      }
      const memoryDocId = input.memory_doc_id ?? `mem_${crypto.randomUUID()}`;
      const latest = db
        .prepare(
          "select max(version) as version from memory_document_versions where memory_doc_id = ?",
        )
        .get(memoryDocId) as { version: number | null };
      const record: MemoryDocumentRecord = {
        memory_doc_id: memoryDocId,
        scope: input.scope,
        owner_id: requireText(input.owner_id, "owner_id"),
        title: requireText(input.title, "title"),
        version: (latest.version ?? 0) + 1,
        content: input.content,
        status: "active",
        created_at: new Date().toISOString(),
      };
      db.prepare(
        "insert into memory_document_versions (memory_doc_id, version, scope, owner_id, title, content, status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        record.memory_doc_id,
        record.version,
        record.scope,
        record.owner_id,
        record.title,
        record.content,
        record.status,
        record.created_at,
      );
      return record;
    },

    listMemoryDocumentVersions(memoryDocId) {
      return db
        .prepare(
          "select memory_doc_id, scope, owner_id, title, version, content, status, created_at from memory_document_versions where memory_doc_id = ? order by version asc",
        )
        .all(memoryDocId) as MemoryDocumentRecord[];
    },

    listCurrentMemoryDocuments(input) {
      return listCurrentMemoryDocuments(db, input);
    },

    close() {
      db.close();
    },
  };
}

function botToChannelRecord(bot: BotRecord): BotChannelRecord {
  const secretConfigured = bot.wecom_secret_configured;
  const hasWeComBotId = Boolean(bot.wecom_bot_id);
  const runtimeEnabled = hasWeComBotId && secretConfigured;
  const runtimeStatus = !hasWeComBotId
    ? "missing_bot_id"
    : !secretConfigured
      ? "missing_secret"
      : "enabled";
  return {
    channel_id: `wecom:${bot.bot_id}`,
    bot_id: bot.bot_id,
    channel_type: "wecom",
    display_name: "企业微信",
    ...(bot.wecom_bot_id ? { wecom_bot_id: bot.wecom_bot_id } : {}),
    secret_configured: secretConfigured,
    connection_status: bot.wecom_connection_status,
    runtime_enabled: runtimeEnabled,
    runtime_status: runtimeStatus,
    ...(bot.last_wecom_check_at ? { last_check_at: bot.last_wecom_check_at } : {}),
    ...(bot.last_wecom_error ? { last_error: bot.last_wecom_error } : {}),
  };
}

function getBotChannelDetail(
  db: Database.Database,
  botId: string,
): BotChannelDetail {
  const bot = getRequiredBot(db, botId);
  const admin = db
    .prepare("select * from admins where bot_id = ?")
    .get(bot.bot_id) as AdminRecord | undefined;
  const memoryDocuments = listCurrentMemoryDocuments(db, {
    scope: "bot",
    owner_id: bot.bot_id,
  });
  return {
    channel: botToChannelRecord(bot),
    bot,
    ...(admin ? { admin } : {}),
    memory_documents: memoryDocuments,
    config_documents: listBotConfigDocuments(db, bot.bot_id),
  };
}

function upsertBotConfigDocument(
  db: Database.Database,
  input: UpsertBotConfigDocumentInput,
): BotConfigDocumentRecord {
  const bot = getRequiredBot(db, input.bot_id);
  const title = requireBotConfigDocumentTitle(input.title);
  const existing = db
    .prepare("select created_at from bot_config_documents where bot_id = ? and title = ?")
    .get(bot.bot_id, title) as { created_at: string } | undefined;
  const now = new Date().toISOString();
  const record: BotConfigDocumentRecord = {
    bot_id: bot.bot_id,
    title,
    content: input.content,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  db.prepare(
    `
      insert into bot_config_documents (bot_id, title, content, created_at, updated_at)
      values (?, ?, ?, ?, ?)
      on conflict(bot_id, title) do update set
        content = excluded.content,
        updated_at = excluded.updated_at
    `,
  ).run(record.bot_id, record.title, record.content, record.created_at, record.updated_at);
  return record;
}

function listBotConfigDocuments(
  db: Database.Database,
  botId: string,
): BotConfigDocumentRecord[] {
  const bot = getRequiredBot(db, botId);
  const rows = db
    .prepare(
      `
        select bot_id, title, content, created_at, updated_at
        from bot_config_documents
        where bot_id = ?
      `,
    )
    .all(bot.bot_id) as BotConfigDocumentRecord[];
  return rows.sort((left, right) => configDocumentOrder(left.title) - configDocumentOrder(right.title));
}

function updateBot(
  db: Database.Database,
  botId: string,
  input: UpdateBotInput,
): BotRecord {
  const bot = getRequiredBot(db, botId);
  const wecomSecret = optionalText(input.wecom_secret);
  const wecomBotId = input.wecom_bot_id === undefined
    ? bot.wecom_bot_id
    : optionalText(input.wecom_bot_id);
  assertUniqueWeComBotId(db, wecomBotId, bot.bot_id);
  const updated: BotRecord = {
    ...bot,
    name: input.name === undefined ? bot.name : requireText(input.name, "name"),
    runtime: input.runtime === undefined
      ? bot.runtime
      : requireText(input.runtime, "runtime"),
    status: input.status === undefined
      ? bot.status
      : requireBotStatus(input.status),
    wecom_bot_id: wecomBotId,
    wecom_secret_configured: wecomSecret
      ? true
      : bot.wecom_secret_configured,
    wecom_connection_status: "unchecked",
    last_wecom_check_at: undefined,
    last_wecom_error: undefined,
    updated_at: nextIsoTimestamp(bot.updated_at),
  };
  const currentSecret = db
    .prepare("select wecom_secret from bots where bot_id = ?")
    .get(botId) as { wecom_secret?: string | null };
  db.prepare(
    "update bots set name = ?, runtime = ?, status = ?, wecom_bot_id = ?, wecom_secret = ?, wecom_connection_status = ?, last_wecom_check_at = ?, last_wecom_error = ?, updated_at = ? where bot_id = ?",
  ).run(
    updated.name,
    updated.runtime,
    updated.status,
    updated.wecom_bot_id ?? null,
    wecomSecret ?? currentSecret.wecom_secret ?? null,
    updated.wecom_connection_status,
    null,
    null,
    updated.updated_at,
    updated.bot_id,
  );
  return updated;
}

async function testWeComConnection(
  db: Database.Database,
  botId: string,
  options: DataStoreOptions,
): Promise<ReturnType<typeof buildWeComConnectionTestResult>> {
  const bot = getRequiredBot(db, botId);
  const secretRecord = db
    .prepare("select wecom_secret from bots where bot_id = ?")
    .get(botId) as { wecom_secret?: string | null };
  const prelim = buildWeComConnectionTestResult(bot);
  const secret = typeof secretRecord.wecom_secret === "string"
    ? secretRecord.wecom_secret
    : undefined;
  const verification = prelim.status === "configured" && options.wecomVerifier && secret
    ? await options.wecomVerifier.verify({
      bot_id: bot.wecom_bot_id ?? "",
      secret,
    })
    : undefined;
  const result = buildWeComConnectionTestResult(bot, verification);
  const updatedAt = nextIsoTimestamp(bot.updated_at);
  db.prepare(
    "update bots set wecom_connection_status = ?, last_wecom_check_at = ?, last_wecom_error = ?, updated_at = ? where bot_id = ?",
  ).run(
    result.status,
    result.checked_at,
    result.error ?? null,
    updatedAt,
    bot.bot_id,
  );
  return result;
}

function transferAdmin(
  db: Database.Database,
  input: TransferAdminInput,
): AdminRecord {
  const bot = getRequiredBot(db, input.bot_id);
  const existing = db
    .prepare("select * from admins where bot_id = ?")
    .get(bot.bot_id);
  if (!existing) {
    throw new Error(`admin is not claimed for bot: ${bot.bot_id}`);
  }
  const existingAdmin = existing as AdminRecord;
  if (
    existingAdmin.wecom_user_id !==
    requireText(input.current_wecom_user_id, "current_wecom_user_id")
  ) {
    throw new Error("current admin does not match");
  }

  const admin: AdminRecord = {
    bot_id: bot.bot_id,
    wecom_user_id: requireText(input.new_wecom_user_id, "new_wecom_user_id"),
    role: "admin",
    claimed_at: new Date().toISOString(),
  };
  db.prepare(
    "update admins set wecom_user_id = ?, role = ?, claimed_at = ? where bot_id = ?",
  ).run(admin.wecom_user_id, admin.role, admin.claimed_at, admin.bot_id);
  return admin;
}

function listCurrentMemoryDocuments(
  db: Database.Database,
  input: ListCurrentMemoryDocumentsInput,
): MemoryDocumentRecord[] {
  return db
    .prepare(
      `
        select
          memory_doc_id,
          scope,
          owner_id,
          title,
          version,
          content,
          status,
          created_at
        from memory_document_versions
        where scope = ?
          and owner_id = ?
          and not (scope = 'bot' and lower(title) in ('soul', 'soul.md', 'private/soul.md', 'agents', 'agents.md', 'instructions/agents.md'))
          and version = (
            select max(latest.version)
            from memory_document_versions latest
            where latest.memory_doc_id = memory_document_versions.memory_doc_id
          )
        order by (
          select min(first_version.rowid)
          from memory_document_versions first_version
          where first_version.memory_doc_id = memory_document_versions.memory_doc_id
        ) asc
      `,
    )
    .all(input.scope, requireText(input.owner_id, "owner_id")) as MemoryDocumentRecord[];
}

function migrate(db: Database.Database): void {
  db.exec(`
    create table if not exists bots (
      bot_id text primary key,
      name text not null,
      runtime text not null,
      status text not null,
      wecom_bot_id text,
      wecom_secret text,
      wecom_connection_status text not null default 'unchecked',
      last_wecom_check_at text,
      last_wecom_error text,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists admins (
      bot_id text primary key,
      wecom_user_id text not null,
      role text not null,
      claimed_at text not null
    );

    create table if not exists admin_claims (
      bot_id text primary key,
      code_hash text not null,
      created_at text not null,
      expires_at text not null
    );

    create table if not exists conversations (
      conversation_key text primary key,
      conversation_id text not null,
      bot_id text not null,
      wecom_user_id text not null,
      channel text not null,
      purpose text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists memory_document_versions (
      memory_doc_id text not null,
      version integer not null,
      scope text not null,
      owner_id text not null,
      title text not null,
      content text not null,
      status text not null,
      created_at text not null,
      primary key (memory_doc_id, version)
    );

    create table if not exists bot_config_documents (
      bot_id text not null,
      title text not null,
      content text not null,
      created_at text not null,
      updated_at text not null,
      primary key (bot_id, title)
    );

    create table if not exists bot_config_document_versions (
      bot_id text not null,
      title text not null,
      version integer not null,
      content text not null,
      created_at text not null,
      primary key (bot_id, title, version)
    );
  `);
  addColumnIfMissing(db, "bots", "wecom_bot_id", "text");
  addColumnIfMissing(db, "bots", "wecom_secret", "text");
  addColumnIfMissing(
    db,
    "bots",
    "wecom_connection_status",
    "text not null default 'unchecked'",
  );
  addColumnIfMissing(db, "bots", "last_wecom_check_at", "text");
  addColumnIfMissing(db, "bots", "last_wecom_error", "text");
  db.prepare(
    "create unique index if not exists idx_bots_wecom_bot_id_unique on bots (wecom_bot_id) where wecom_bot_id is not null",
  ).run();
  migrateBotConfigDocuments(db);
}

function migrateBotConfigDocuments(db: Database.Database): void {
  db.prepare(
    `
      insert or ignore into bot_config_document_versions (bot_id, title, version, content, created_at)
      select
        owner_id as bot_id,
        case
          when lower(title) in ('soul', 'soul.md', 'private/soul.md') then 'soul'
          else 'agents.md'
        end as title,
        version,
        content,
        created_at
      from memory_document_versions
      where scope = 'bot'
        and lower(title) in ('soul', 'soul.md', 'private/soul.md', 'agents', 'agents.md', 'instructions/agents.md')
    `,
  ).run();
  db.prepare(
    `
      insert into bot_config_documents (bot_id, title, content, created_at, updated_at)
      select source.bot_id, source.title, source.content, source.created_at, source.created_at
      from bot_config_document_versions source
      where source.version = (
        select max(latest.version)
        from bot_config_document_versions latest
        where latest.bot_id = source.bot_id
          and latest.title = source.title
      )
      on conflict(bot_id, title) do nothing
    `,
  ).run();
  db.prepare(
    `
      delete from memory_document_versions
      where scope = 'bot'
        and lower(title) in ('soul', 'soul.md', 'private/soul.md', 'agents', 'agents.md', 'instructions/agents.md')
    `,
  ).run();
}

function assertUniqueWeComBotId(
  db: Database.Database,
  wecomBotId: string | undefined,
  currentBotId?: string,
): void {
  if (!wecomBotId) {
    return;
  }

  const existing = db
    .prepare("select bot_id from bots where wecom_bot_id = ? and bot_id != ?")
    .get(wecomBotId, currentBotId ?? "") as { bot_id: string } | undefined;
  if (existing) {
    throw new Error(`wecom bot id already bound to bot: ${existing.bot_id}`);
  }
}

function claimAdmin(db: Database.Database, input: ClaimAdminInput): AdminRecord {
  const bot = getRequiredBot(db, input.bot_id);
  const existing = db
    .prepare("select * from admins where bot_id = ?")
    .get(input.bot_id);
  if (existing) {
    throw new Error(`admin already claimed for bot: ${input.bot_id}`);
  }

  const now = new Date().toISOString();
  const admin: AdminRecord = {
    bot_id: bot.bot_id,
    wecom_user_id: requireText(input.wecom_user_id, "wecom_user_id"),
    role: "admin",
    claimed_at: now,
  };
  db.prepare(
    "insert into admins (bot_id, wecom_user_id, role, claimed_at) values (?, ?, ?, ?)",
  ).run(admin.bot_id, admin.wecom_user_id, admin.role, admin.claimed_at);
  db.prepare("update bots set status = ?, updated_at = ? where bot_id = ?").run(
    "initializing",
    now,
    bot.bot_id,
  );
  return admin;
}

function resolveConversation(
  db: Database.Database,
  input: ResolveConversationInput,
): ConversationRecord {
  getRequiredBot(db, input.bot_id);
  const key = [
    input.bot_id,
    input.wecom_user_id,
    input.channel,
    input.purpose,
  ].join(":");
  const existing = db
    .prepare(
      "select conversation_id, bot_id, wecom_user_id, channel, purpose, created_at, updated_at from conversations where conversation_key = ?",
    )
    .get(key) as ConversationRecord | undefined;
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const conversation: ConversationRecord = {
    conversation_id: `conv_${crypto.randomUUID()}`,
    bot_id: input.bot_id,
    wecom_user_id: input.wecom_user_id,
    channel: input.channel,
    purpose: input.purpose,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    "insert into conversations (conversation_key, conversation_id, bot_id, wecom_user_id, channel, purpose, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    key,
    conversation.conversation_id,
    conversation.bot_id,
    conversation.wecom_user_id,
    conversation.channel,
    conversation.purpose,
    conversation.created_at,
    conversation.updated_at,
  );
  return conversation;
}

function getRequiredBot(db: Database.Database, botId: string): BotRecord {
  const bot = mapBotRecord(db.prepare("select * from bots where bot_id = ?").get(botId));
  if (!bot) {
    throw new Error(`bot not found: ${botId}`);
  }
  return bot;
}

function mapBotRecord(row: unknown): BotRecord | undefined {
  if (!row || typeof row !== "object") {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  const wecomBotId = typeof record.wecom_bot_id === "string"
    ? record.wecom_bot_id
    : undefined;
  const wecomSecret = typeof record.wecom_secret === "string"
    ? record.wecom_secret
    : undefined;
  return {
    bot_id: record.bot_id as string,
    name: record.name as string,
    runtime: record.runtime as string,
    status: record.status as BotRecord["status"],
    ...(wecomBotId ? { wecom_bot_id: wecomBotId } : {}),
    wecom_secret_configured: Boolean(wecomSecret),
    wecom_connection_status: typeof record.wecom_connection_status === "string"
      ? record.wecom_connection_status as BotRecord["wecom_connection_status"]
      : "unchecked",
    ...(typeof record.last_wecom_check_at === "string"
      ? { last_wecom_check_at: record.last_wecom_check_at }
      : {}),
    ...(typeof record.last_wecom_error === "string"
      ? { last_wecom_error: record.last_wecom_error }
      : {}),
    created_at: record.created_at as string,
    updated_at: record.updated_at as string,
  };
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((existing) => existing.name === column)) {
    db.prepare(`alter table ${table} add column ${column} ${type}`).run();
  }
}
