import {
  createDataStore,
  requireMemoryScope,
  type DataStore,
} from "./store.js";

export interface DataServiceServer {
  fetch(request: Request): Promise<Response>;
}

export function createDataServiceServer(
  store: DataStore = createDataStore(),
): DataServiceServer {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          service: "data-service",
          status: "ok",
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/bots") {
        return handleCreateBot(request, store);
      }

      if (request.method === "GET" && url.pathname === "/v1/bots") {
        return handleListBots(store);
      }

      if (request.method === "GET" && url.pathname === "/v1/bot-channels") {
        return handleListBotChannels(url, store);
      }

      const channelRoute = parseWeComChannelRoute(url.pathname);
      if (request.method === "GET" && channelRoute) {
        return handleGetBotChannelDetail(store, channelRoute.botId);
      }
      if (request.method === "DELETE" && channelRoute) {
        return handleDeleteBotChannel(store, channelRoute.botId);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/internal/wecom-runtime/bots"
      ) {
        return handleListWeComRuntimeBots(store);
      }

      const botMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)$/);
      if (request.method === "GET" && botMatch) {
        return handleGetBot(store, botMatch[1]);
      }
      if (request.method === "PATCH" && botMatch) {
        return handleUpdateBot(request, store, botMatch[1]);
      }

      const botConfigDocumentsMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/config-documents$/,
      );
      if (request.method === "GET" && botConfigDocumentsMatch) {
        return handleListBotConfigDocuments(store, botConfigDocumentsMatch[1]);
      }

      const wecomTestMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/wecom\/test$/,
      );
      if (request.method === "POST" && wecomTestMatch) {
        return handleTestWeComConnection(store, wecomTestMatch[1]);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/conversations/resolve"
      ) {
        return handleResolveConversation(request, store);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/message-context/resolve"
      ) {
        return handleResolveMessageContext(request, store);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/memory-documents"
      ) {
        return handleUpsertMemoryDocument(request, store);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/bot-config-documents"
      ) {
        return handleUpsertBotConfigDocument(request, store);
      }

      if (
        request.method === "GET" &&
        url.pathname === "/v1/memory-documents/current"
      ) {
        return handleListCurrentMemoryDocuments(url, store);
      }

      const memoryDocumentVersionsMatch = url.pathname.match(
        /^\/v1\/memory-documents\/([^/]+)\/versions$/,
      );
      if (request.method === "GET" && memoryDocumentVersionsMatch) {
        return handleListMemoryDocumentVersions(
          store,
          memoryDocumentVersionsMatch[1],
        );
      }

      const adminClaimMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/admin\/claim$/,
      );
      if (request.method === "POST" && adminClaimMatch) {
        return handleClaimAdmin(request, store, adminClaimMatch[1]);
      }

      const adminClaimsMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/admin\/claims$/,
      );
      if (request.method === "POST" && adminClaimsMatch) {
        return handleCreateAdminClaim(store, adminClaimsMatch[1]);
      }

      const adminResetMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/admin\/reset$/,
      );
      if (request.method === "POST" && adminResetMatch) {
        return handleResetAdminClaim(store, adminResetMatch[1]);
      }

      const adminMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/admin$/);
      if (request.method === "GET" && adminMatch) {
        return handleGetAdmin(store, adminMatch[1]);
      }

      const adminTransferMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/admin\/transfer$/,
      );
      if (request.method === "POST" && adminTransferMatch) {
        return handleTransferAdmin(request, store, adminTransferMatch[1]);
      }

      const adminClaimVerifyMatch = url.pathname.match(
        /^\/v1\/bots\/([^/]+)\/admin\/claim\/verify$/,
      );
      if (request.method === "POST" && adminClaimVerifyMatch) {
        return handleVerifyAdminClaim(request, store, adminClaimVerifyMatch[1]);
      }

      const readyMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/ready$/);
      if (request.method === "POST" && readyMatch) {
        return handleMarkReady(store, readyMatch[1]);
      }

      const resetMatch = url.pathname.match(/^\/v1\/bots\/([^/]+)\/reset$/);
      if (request.method === "POST" && resetMatch) {
        return handleResetBot(store, resetMatch[1]);
      }

      return jsonResponse({ error: "not found" }, 404);
    },
  };
}

async function handleCreateBot(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.createBot(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetBot(store: DataStore, botId: string): Response {
  try {
    const bot = store.getBot(botId);
    if (!bot) {
      return jsonResponse({ error: `bot not found: ${botId}` }, 404);
    }
    return jsonResponse(bot);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListBots(store: DataStore): Response {
  try {
    return jsonResponse(store.listBots());
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListBotChannels(url: URL, store: DataStore): Response {
  try {
    return jsonResponse(
      store.listBotChannels(url.searchParams.get("bot_id") ?? undefined),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

function parseWeComChannelRoute(pathname: string): { botId: string } | undefined {
  const match = pathname.match(/^\/v1\/bot-channels\/(.+)$/);
  if (!match) {
    return undefined;
  }
  const channelId = decodeURIComponent(match[1]);
  if (!channelId.startsWith("wecom:")) {
    return undefined;
  }
  const botId = channelId.slice("wecom:".length);
  return botId ? { botId } : undefined;
}

function handleGetBotChannelDetail(store: DataStore, botId: string): Response {
  try {
    return jsonResponse(store.getBotChannelDetail(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleDeleteBotChannel(store: DataStore, botId: string): Response {
  try {
    return jsonResponse(store.deleteBotChannel(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListWeComRuntimeBots(store: DataStore): Response {
  try {
    return jsonResponse(store.listWeComRuntimeBots());
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpdateBot(
  request: Request,
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    return jsonResponse(store.updateBot(botId, await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleTestWeComConnection(
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    return jsonResponse(await store.testWeComConnection(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleResolveConversation(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.resolveConversation(await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleResolveMessageContext(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.resolveMessageContext(await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleClaimAdmin(
  request: Request,
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as { wecom_user_id?: string };
    return jsonResponse(
      store.claimAdmin({
        bot_id: botId,
        wecom_user_id: body.wecom_user_id ?? "",
      }),
      201,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpsertMemoryDocument(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.upsertMemoryDocument(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleUpsertBotConfigDocument(
  request: Request,
  store: DataStore,
): Promise<Response> {
  try {
    return jsonResponse(store.upsertBotConfigDocument(await request.json()), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListBotConfigDocuments(
  store: DataStore,
  botId: string,
): Response {
  try {
    return jsonResponse(store.listBotConfigDocuments(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListMemoryDocumentVersions(
  store: DataStore,
  memoryDocId: string,
): Response {
  try {
    return jsonResponse(store.listMemoryDocumentVersions(memoryDocId));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleListCurrentMemoryDocuments(
  url: URL,
  store: DataStore,
): Response {
  try {
    return jsonResponse(
      store.listCurrentMemoryDocuments({
        scope: requireMemoryScope(url.searchParams.get("scope")),
        owner_id: url.searchParams.get("owner_id") ?? "",
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

function handleMarkReady(store: DataStore, botId: string): Response {
  try {
    return jsonResponse(store.markBotReady(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleResetBot(store: DataStore, botId: string): Response {
  try {
    return jsonResponse(store.resetBot(botId));
  } catch (error) {
    return errorResponse(error);
  }
}

function handleCreateAdminClaim(store: DataStore, botId: string): Response {
  try {
    return jsonResponse(store.createAdminClaim(botId), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleResetAdminClaim(store: DataStore, botId: string): Response {
  try {
    return jsonResponse(store.resetAdminClaim(botId), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

function handleGetAdmin(store: DataStore, botId: string): Response {
  try {
    const admin = store.getAdmin(botId);
    if (!admin) {
      return jsonResponse({ error: `admin not found for bot: ${botId}` }, 404);
    }
    return jsonResponse(admin);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleTransferAdmin(
  request: Request,
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      current_wecom_user_id?: string;
      new_wecom_user_id?: string;
    };
    return jsonResponse(
      store.transferAdmin({
        bot_id: botId,
        current_wecom_user_id: body.current_wecom_user_id ?? "",
        new_wecom_user_id: body.new_wecom_user_id ?? "",
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleVerifyAdminClaim(
  request: Request,
  store: DataStore,
  botId: string,
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      wecom_user_id?: string;
      code?: string;
    };
    return jsonResponse(
      store.verifyAdminClaim({
        bot_id: botId,
        wecom_user_id: body.wecom_user_id ?? "",
        code: body.code ?? "",
      }),
      201,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown): Response {
  return jsonResponse(
    { error: error instanceof Error ? error.message : "invalid request" },
    400,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
