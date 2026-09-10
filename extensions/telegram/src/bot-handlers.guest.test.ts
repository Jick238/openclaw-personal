import { describe, expect, it, vi } from "vitest";
import { registerTelegramGuestHandler } from "./bot-handlers.guest.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";

function createParams(runResultOnly?: (request: any) => Promise<unknown>) {
  const handlers = new Map<string, (ctx: any) => Promise<void>>();
  const params = {
    accountId: "default",
    ownerAgentId: "main",
    bot: {
      on: (trigger: string, handler: (ctx: any) => Promise<void>) => handlers.set(trigger, handler),
      api: {},
    },
    opts: { token: "token", externalTurns: runResultOnly ? { runResultOnly } : undefined },
    cfg: { commands: { ownerAllowFrom: ["42"] } },
    telegramCfg: {},
    telegramDeps: { readChannelAllowFromStore: vi.fn(async () => []) },
    logger: { warn: vi.fn(), info: vi.fn() },
  } as unknown as RegisterTelegramHandlerParams;
  registerTelegramGuestHandler(params);
  return { handlers, params };
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
  it("runs one ordinary Front turn and answers one generated article", async () => {
    const runResultOnly = vi.fn(async () => ({ kind: "completed" as const, text: "model answer" }));
    const { handlers } = createParams(runResultOnly);
    const ctx = guestContext({ id: "guest-1", text: "summarize this arbitrary request" });

    await handlers.get("guest_message")!(ctx);

    expect(runResultOnly).toHaveBeenCalledOnce();
    expect(runResultOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: "42",
        senderIsOwner: true,
        correlationId: "guest:guest-1",
        prompt: expect.stringContaining("summarize this arbitrary request"),
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

  it("passes bounded reply text, caption, and media context to the same model turn", async () => {
    const runResultOnly = vi.fn(async () => ({ kind: "completed" as const, text: "answer" }));
    const { handlers } = createParams(runResultOnly);
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

    const request = (runResultOnly.mock.calls as unknown[][])[0]?.[0] as Record<string, any>;
    expect(request.prompt).toContain("rewrite it");
    expect(request.prompt).toContain("original caption");
    expect(request.prompt).toContain("Attachment: photo");
    expect(request.prompt).not.toContain("private-file-id");
    expect(request.sessionKey).toContain("guest:42:guest-reply");
    expect(request.sessionKey).not.toBe("telegram:default:direct:42");
  });

  it("records unauthorized callers and missing query ids without running Front", async () => {
    const runResultOnly = vi.fn(async () => ({ kind: "empty" as const }));
    const { handlers, params } = createParams(runResultOnly);
    const unauthorized = guestContext({ id: "guest-unauthorized", text: "secret", senderId: 99 });
    await handlers.get("guest_message")!(unauthorized);
    expect(runResultOnly).not.toHaveBeenCalled();
    expect(unauthorized.answerGuestQuery).not.toHaveBeenCalled();
    expect(params.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "caller-unauthorized", updateId: 1 }),
      "telegram guest turn not admitted",
    );

    const missingQueryId = guestContext({ id: "guest-missing-id", text: "secret" });
    delete (missingQueryId.guestMessage as Record<string, unknown>).guest_query_id;
    await handlers.get("guest_message")!(missingQueryId);
    expect(runResultOnly).not.toHaveBeenCalled();
    expect(missingQueryId.answerGuestQuery).not.toHaveBeenCalled();
    expect(params.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "guest-query-id-missing", updateId: 1 }),
      "telegram guest turn not admitted",
    );
    expect(JSON.stringify(params.logger.info.mock.calls)).not.toContain("secret");
  });

  it("records empty model results without answering Telegram", async () => {
    const runResultOnly = vi.fn(async () => ({ kind: "empty" as const }));
    const { handlers, params } = createParams(runResultOnly);
    const empty = guestContext({ id: "guest-empty", text: "nothing" });
    await handlers.get("guest_message")!(empty);
    expect(runResultOnly).toHaveBeenCalledOnce();
    expect(empty.answerGuestQuery).not.toHaveBeenCalled();
    expect(params.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "result-empty", updateId: 1 }),
      "telegram guest turn not admitted",
    );
  });

  it("deduplicates the authoritative guest query id", async () => {
    const runResultOnly = vi.fn(async () => ({ kind: "completed" as const, text: "answer" }));
    const { handlers } = createParams(runResultOnly);
    const first = guestContext({ id: "guest-retry", text: "same" });
    const retry = guestContext({ id: "guest-retry", text: "same" });
    await Promise.all([
      handlers.get("guest_message")!(first),
      handlers.get("guest_message")!(retry),
    ]);

    expect(runResultOnly).toHaveBeenCalledOnce();
    expect(first.answerGuestQuery).toHaveBeenCalledOnce();
    expect(retry.answerGuestQuery).not.toHaveBeenCalled();
  });

  it("releases an in-flight key after a transient model failure", async () => {
    const runResultOnly = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary provider failure"))
      .mockResolvedValueOnce({ kind: "completed" as const, text: "retry answer" });
    const { handlers } = createParams(runResultOnly);
    const first = guestContext({ id: "guest-retryable", text: "retry me" });
    await handlers.get("guest_message")!(first);
    expect(first.answerGuestQuery).not.toHaveBeenCalled();

    const retry = guestContext({ id: "guest-retryable", text: "retry me" });
    await handlers.get("guest_message")!(retry);
    expect(runResultOnly).toHaveBeenCalledTimes(2);
    expect(retry.answerGuestQuery).toHaveBeenCalledOnce();
  });
});
