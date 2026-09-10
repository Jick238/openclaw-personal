import { describe, expect, it, vi } from "vitest";
import { registerTelegramGuestHandler } from "./bot-handlers.guest.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";

function createParams(
  processMessageWithReplyChain: TelegramMessagePipeline["processMessageWithReplyChain"] = vi.fn(
    async ({ options }) => {
      await options?.responseTarget?.deliver("model answer");
      return { kind: "completed" as const };
    },
  ),
) {
  const handlers = new Map<string, (ctx: any) => Promise<void>>();
  const params = {
    accountId: "default",
    ownerAgentId: "main",
    bot: {
      on: (trigger: string, handler: (ctx: any) => Promise<void>) => handlers.set(trigger, handler),
      api: {},
    },
    opts: { token: "token" },
    cfg: { commands: { ownerAllowFrom: ["42"] } },
    telegramCfg: {},
    telegramDeps: { readChannelAllowFromStore: vi.fn(async () => []) },
    logger: { warn: vi.fn(), info: vi.fn() },
  } as unknown as RegisterTelegramHandlerParams;
  const messagePipeline = {
    buildSyntheticTextMessage: vi.fn(({ base, text }: { base: any; text: string }) => ({
      ...base,
      text,
      caption: undefined,
      caption_entities: undefined,
    })),
    buildSyntheticContext: vi.fn((ctx: any, message: any) => ({ ...ctx, message })),
    processMessageWithReplyChain,
  } as unknown as Pick<
    TelegramMessagePipeline,
    "buildSyntheticTextMessage" | "buildSyntheticContext" | "processMessageWithReplyChain"
  >;
  registerTelegramGuestHandler(params, messagePipeline);
  return { handlers, params, messagePipeline };
}

function guestContext(params: {
  id: string;
  text?: string;
  reply?: Record<string, unknown>;
  senderId?: number;
  media?: Record<string, unknown>;
}) {
  const senderId = params.senderId ?? 42;
  return {
    update: { update_id: 1, guest_message: { guest_query_id: params.id } },
    me: { username: "hickss_bot" },
    guestMessage: {
      message_id: 9,
      guest_query_id: params.id,
      ...(params.text !== undefined ? { text: `@hickss_bot ${params.text}` } : {}),
      ...params.media,
      from: { id: senderId, first_name: "Owner", username: "owner" },
      chat: { id: 777, type: "private" },
      ...(params.reply ? { reply_to_message: params.reply } : {}),
    },
    answerGuestQuery: vi.fn(async () => ({ inline_message_id: "inline-1" })),
  };
}

describe("Telegram Guest Mode Hicks Front", () => {
  it("builds a synthetic message for the ordinary Front and answers one generated article", async () => {
    const processMessageWithReplyChain = vi.fn<
      TelegramMessagePipeline["processMessageWithReplyChain"]
    >(async ({ options }) => {
      await options?.responseTarget?.deliver("model answer");
      return { kind: "completed" as const };
    });
    const { handlers, messagePipeline } = createParams(processMessageWithReplyChain);
    const ctx = guestContext({ id: "guest-1", text: "summarize this arbitrary request" });

    await handlers.get("guest_message")!(ctx);

    expect(messagePipeline.buildSyntheticTextMessage).toHaveBeenCalledWith({
      base: expect.objectContaining({ guest_query_id: "guest-1" }),
      text: "summarize this arbitrary request",
    });
    expect(messagePipeline.buildSyntheticContext).toHaveBeenCalledOnce();
    expect(processMessageWithReplyChain).toHaveBeenCalledWith(
      expect.objectContaining({
        allMedia: [],
        options: { responseTarget: expect.any(Object) },
      }),
    );
    expect(ctx.answerGuestQuery).toHaveBeenCalledOnce();
    const [result] = (ctx.answerGuestQuery.mock.calls as unknown[][])[0] ?? [];
    expect(result).toMatchObject({
      type: "article",
      input_message_content: {
        parse_mode: "HTML",
        message_text:
          "<blockquote>@hickss_bot summarize this arbitrary request</blockquote>\n\nmodel answer",
      },
    });
    expect(result).not.toHaveProperty("reply_markup");
  });

  it("keeps Telegram result ids within the 64-byte contract", async () => {
    const { handlers } = createParams();
    const ctx = guestContext({ id: "я".repeat(100), text: "answer" });

    await handlers.get("guest_message")!(ctx);

    const [result] = (ctx.answerGuestQuery.mock.calls as unknown[][])[0] ?? [];
    expect(Buffer.byteLength(String((result as { id?: unknown }).id), "utf8")).toBeLessThanOrEqual(
      64,
    );
  });

  it("preserves reply and media context in the synthetic Front message", async () => {
    const processMessageWithReplyChain = vi.fn<
      TelegramMessagePipeline["processMessageWithReplyChain"]
    >(async ({ options }) => {
      await options?.responseTarget?.deliver("answer");
      return { kind: "completed" as const };
    });
    const { handlers, messagePipeline } = createParams(processMessageWithReplyChain);
    const ctx = guestContext({
      id: "guest-reply",
      text: "rewrite it",
      reply: {
        message_id: 8,
        caption: "original caption",
        from: { id: 99, first_name: "Sender", username: "source" },
        photo: [{ file_id: "private-file-id" }],
      },
    });

    await handlers.get("guest_message")!(ctx);

    expect(messagePipeline.buildSyntheticTextMessage).toHaveBeenCalledWith({
      base: expect.objectContaining({
        guest_query_id: "guest-reply",
        reply_to_message: expect.objectContaining({
          caption: "original caption",
          photo: [{ file_id: "private-file-id" }],
        }),
      }),
      text: "rewrite it",
    });
    expect(processMessageWithReplyChain).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.objectContaining({ text: "rewrite it" }),
        allMedia: [],
      }),
    );
  });

  it("records unauthorized callers and missing query ids without running Front", async () => {
    const processMessageWithReplyChain = vi.fn<
      TelegramMessagePipeline["processMessageWithReplyChain"]
    >(async () => ({ kind: "empty" as const }));
    const { handlers, params } = createParams(processMessageWithReplyChain);
    const unauthorized = guestContext({ id: "guest-unauthorized", text: "secret", senderId: 99 });
    await handlers.get("guest_message")!(unauthorized);
    expect(processMessageWithReplyChain).not.toHaveBeenCalled();
    expect(unauthorized.answerGuestQuery).not.toHaveBeenCalled();
    expect(params.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "caller-unauthorized", updateId: 1 }),
      "telegram guest turn not admitted",
    );

    const missingQueryId = guestContext({ id: "guest-missing-id", text: "secret" });
    delete (missingQueryId.guestMessage as Record<string, unknown>).guest_query_id;
    await handlers.get("guest_message")!(missingQueryId);
    expect(processMessageWithReplyChain).not.toHaveBeenCalled();
    expect(missingQueryId.answerGuestQuery).not.toHaveBeenCalled();
    expect(params.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "guest-query-id-missing", updateId: 1 }),
      "telegram guest turn not admitted",
    );
    expect(JSON.stringify(params.logger.info.mock.calls)).not.toContain("secret");
  });

  it("answers a visible blocker when Front skips the guest turn", async () => {
    const processMessageWithReplyChain = vi.fn<
      TelegramMessagePipeline["processMessageWithReplyChain"]
    >(async () => ({ kind: "skipped" as const }));
    const { handlers, params } = createParams(processMessageWithReplyChain);
    const empty = guestContext({ id: "guest-empty", text: "nothing" });
    await handlers.get("guest_message")!(empty);
    expect(processMessageWithReplyChain).toHaveBeenCalledOnce();
    expect(empty.answerGuestQuery).toHaveBeenCalledOnce();
    expect(JSON.stringify(empty.answerGuestQuery.mock.calls)).toContain(
      "Не удалось обработать запрос",
    );
    expect(params.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "result-skipped", updateId: 1 }),
      "telegram guest turn not admitted",
    );
  });

  it("deduplicates the authoritative guest query id", async () => {
    const processMessageWithReplyChain = vi.fn<
      TelegramMessagePipeline["processMessageWithReplyChain"]
    >(async ({ options }) => {
      await options?.responseTarget?.deliver("answer");
      return { kind: "completed" as const };
    });
    const { handlers } = createParams(processMessageWithReplyChain);
    const first = guestContext({ id: "guest-retry", text: "same" });
    const retry = guestContext({ id: "guest-retry", text: "same" });
    await Promise.all([
      handlers.get("guest_message")!(first),
      handlers.get("guest_message")!(retry),
    ]);

    expect(processMessageWithReplyChain).toHaveBeenCalledOnce();
    expect(first.answerGuestQuery).toHaveBeenCalledOnce();
    expect(retry.answerGuestQuery).not.toHaveBeenCalled();
  });

  it("answers a visible blocker and deduplicates after a model failure", async () => {
    const processMessageWithReplyChain = vi
      .fn<TelegramMessagePipeline["processMessageWithReplyChain"]>()
      .mockRejectedValueOnce(new Error("temporary provider failure"))
      .mockImplementationOnce(async ({ options }) => {
        await options?.responseTarget?.deliver("retry answer");
        return { kind: "completed" as const };
      });
    const { handlers } = createParams(processMessageWithReplyChain);
    const first = guestContext({ id: "guest-retryable", text: "retry me" });
    await handlers.get("guest_message")!(first);
    expect(first.answerGuestQuery).toHaveBeenCalledOnce();
    expect(JSON.stringify(first.answerGuestQuery.mock.calls)).toContain(
      "Не удалось обработать запрос",
    );

    const retry = guestContext({ id: "guest-retryable", text: "retry me" });
    await handlers.get("guest_message")!(retry);
    expect(processMessageWithReplyChain).toHaveBeenCalledOnce();
    expect(retry.answerGuestQuery).not.toHaveBeenCalled();
  });
});
