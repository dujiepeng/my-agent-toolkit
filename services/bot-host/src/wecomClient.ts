import { WSClient, generateReqId } from "@wecom/aibot-node-sdk";
import type { TextMessage, WsFrame } from "@wecom/aibot-node-sdk";

export interface IncomingWeComMessage {
  conversationId: string;
  userId: string;
  text: string;
}

export interface WeComClient {
  connect(): Promise<void>;
  disconnect(): void;
  onMessage(handler: (message: IncomingWeComMessage) => Promise<void>): void;
  sendText(conversationId: string, text: string, options?: { finish?: boolean; forceActive?: boolean }): Promise<void>;
}

export class WeComLongConnectionClient implements WeComClient {
  private handler?: (message: IncomingWeComMessage) => Promise<void>;
  private client?: WSClient;
  private frames = new Map<string, WsFrame<TextMessage>>();
  private streamIds = new Map<string, string>();

  constructor(private options: { botId: string; secret: string }) {}

  async connect(): Promise<void> {
    if (!this.options.botId || !this.options.secret) {
      throw new Error("Missing WeCom bot credentials");
    }
    this.client?.disconnect();
    this.client = new WSClient({
      botId: this.options.botId,
      secret: this.options.secret,
      maxReconnectAttempts: -1,
      logger: {
        debug: (...args: unknown[]) => console.debug("[wecom-sdk]", ...args),
        info: (...args: unknown[]) => console.info("[wecom-sdk]", ...args),
        warn: (...args: unknown[]) => console.warn("[wecom-sdk]", ...args),
        error: (...args: unknown[]) => console.error("[wecom-sdk]", ...args),
      },
    });

    this.client.on("connected", () => {
      console.info("[wecom] websocket connected");
    });
    this.client.on("authenticated", () => {
      console.info("[wecom] websocket authenticated");
    });
    this.client.on("disconnected", (reason) => {
      console.warn("[wecom] websocket disconnected", reason);
    });
    this.client.on("reconnecting", (attempt) => {
      console.warn("[wecom] websocket reconnecting", attempt);
    });
    this.client.on("error", (error) => {
      console.error("[wecom] websocket error", error);
    });
    this.client.on("message.text", (frame: WsFrame<TextMessage>) => {
      console.info("[wecom] received text message", {
        req_id: frame.headers?.req_id,
        msgid: frame.body?.msgid,
        chattype: frame.body?.chattype,
        chatid: frame.body?.chatid,
        userid: frame.body?.from?.userid,
      });
      void this.handleTextFrame(frame);
    });
    this.client.on("message", (frame: WsFrame<unknown>) => {
      console.info("[wecom] received message", {
        req_id: frame.headers?.req_id,
        msgtype: frame.body && typeof frame.body === "object"
          ? (frame.body as { msgtype?: unknown }).msgtype
          : undefined,
      });
    });
    this.client.connect();
  }

  disconnect(): void {
    this.client?.disconnect();
  }

  onMessage(handler: (message: IncomingWeComMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async sendText(
    conversationId: string,
    text: string,
    options: { finish?: boolean; forceActive?: boolean } = {},
  ): Promise<void> {
    const frame = this.frames.get(conversationId);
    if (frame && !options.forceActive) {
      const finish = options.finish ?? true;
      const streamId = this.streamIds.get(conversationId) ?? createStreamId();
      this.streamIds.set(conversationId, streamId);
      await this.client?.replyStream(frame, streamId, text, finish);
      if (finish) {
        this.streamIds.delete(conversationId);
      }
      console.info("[wecom] sent passive reply", {
        conversationId,
        streamId,
        finish,
      });
      return;
    }

    await this.client?.sendMessage(conversationId, {
      msgtype: "markdown",
      markdown: { content: text },
    } as never);
    console.info("[wecom] sent active message", { conversationId });
  }

  private async handleTextFrame(frame: WsFrame<TextMessage>): Promise<void> {
    const body = frame.body;
    if (!body?.from?.userid || !body.text?.content) {
      console.warn("[wecom] ignored text message with incomplete body", {
        hasUserId: Boolean(body?.from?.userid),
        hasText: Boolean(body?.text?.content),
      });
      return;
    }
    const conversationId = body.chatid ?? body.from.userid;
    this.frames.set(conversationId, frame);
    await this.handler?.({
      conversationId,
      userId: body.from.userid,
      text: body.text.content,
    });
  }

}

export function createStreamId(): string {
  return generateReqId("stream");
}
