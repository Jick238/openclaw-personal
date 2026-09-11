import { createHash } from "node:crypto";
import type { InlineQueryResult } from "grammy/types";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import type { TelegramAlternateFinalResponseTarget } from "./bot-message-context.types.js";
import {
  resolveTelegramCommandAuthorization,
  resolveTelegramMessageThreadSpec,
} from "./bot/helpers.js";

const GUEST_QUERY_MAX_CHARS = 256;
const GUEST_RESULT_MAX_CHARS = 4_096;
const GUEST_FAILURE_TEXT = "Не удалось обработать запрос. Попробуйте ещё раз.";
const GUEST_DEDUPE_TTL_MS = 10 * 60 * 1_000;
const GUEST_DEDUPE_MAX_ENTRIES = 1_024;

type GuestMessage = {
  message_id?: unknown;
  guest_query_id?: unknown;
  text?: unknown;
  caption?: unknown;
  from?: { id?: unknown; first_name?: unknown; last_name?: unknown; username?: unknown };
  chat?: { id?: unknown; type?: unknown };
  reply_to_message?: GuestMessage;
  [key: string]: unknown;
};

type GuestAnswerContext = {
  guestMessage?: GuestMessage;
  me?: { username?: string };
  answerGuestQuery: (result: InlineQueryResult, signal?: AbortSignal) => Promise<unknown>;
};

type GuestDedupeEntry = { expiresAt: number; work: Promise<void>; answered: boolean };
const guestDedupe = new Map<string, GuestDedupeEntry>();

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function identifierValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function bounded(value: string, maxChars: number): string {
  const normalized = value.replaceAll("\r", "").trim();
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeHtmlBounded(value: string, maxChars: number): string {
  let output = "";
  let truncated = false;
  for (const character of value) {
    const escaped = escapeHtml(character);
    if (output.length + escaped.length > maxChars) {
      truncated = true;
      break;
    }
    output += escaped;
  }
  if (truncated && output.length < maxChars) {
    output += "…";
  }
  return output;
}

function guestQueryHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function messageText(message: GuestMessage | undefined): string {
  return textValue(message?.text) || textValue(message?.caption);
}

function guestPrompt(params: { message: GuestMessage; botUsername?: string }): string {
  const raw = messageText(params.message);
  const mention = params.botUsername ? new RegExp(`^@${params.botUsername}\\s*`, "iu") : undefined;
  const instruction = bounded(
    mention ? raw.replace(mention, "").trim() : raw,
    GUEST_QUERY_MAX_CHARS,
  );
  return instruction || "Respond to the referenced message.";
}

function quoteText(params: { message: GuestMessage; botUsername?: string }): string {
  const source = bounded(messageText(params.message), GUEST_QUERY_MAX_CHARS);
  if (source) {
    return source;
  }
  return params.botUsername ? `@${params.botUsername} Reply` : "Reply";
}

function guestResult(params: {
  message: GuestMessage;
  answer: string;
  botUsername?: string;
}): InlineQueryResult {
  const quote = escapeHtmlBounded(quoteText(params), 1_024);
  const answer = escapeHtmlBounded(
    params.answer,
    Math.max(1, GUEST_RESULT_MAX_CHARS - quote.length - 32),
  );
  return {
    type: "article",
    id: `hicks-guest-${guestQueryHash(String(params.message.guest_query_id)).slice(0, 52)}`,
    title: "Hicks",
    description: bounded(params.answer, 180),
    input_message_content: {
      message_text: `<blockquote>${quote}</blockquote>\n\n${answer}`,
      parse_mode: "HTML",
    },
  };
}

function pruneGuestDedupe(now: number): void {
  for (const [key, entry] of guestDedupe) {
    if (entry.answered && entry.expiresAt <= now) {
      guestDedupe.delete(key);
    }
  }
}

function readGuestMessage(ctx: GuestAnswerContext): GuestMessage | undefined {
  return ctx.guestMessage ?? undefined;
}

export function registerTelegramGuestHandler(
  params: RegisterTelegramHandlerParams,
  messagePipeline: Pick<
    TelegramMessagePipeline,
    "buildSyntheticTextMessage" | "buildSyntheticContext" | "processMessageWithReplyChain"
  >,
): void {
  const { bot, accountId, cfg, logger } = params;
  bot.on("guest_message", async (ctx) => {
    const guestCtx = ctx as unknown as GuestAnswerContext;
    const guestMessage = readGuestMessage(guestCtx);
    const guestQueryId = textValue(guestMessage?.guest_query_id);
    // Incoming guest_message identifies its caller on Message.from/chat;
    // guest_bot_caller_* belongs to messages sent by a guest bot and never gates ingress.
    const caller = guestMessage?.from;
    const callerChat = guestMessage?.chat;
    const chatId = callerChat?.id;
    const senderId = identifierValue(caller?.id);
    const recordDrop = (reason: string) => {
      logger.info(
        {
          accountId,
          reason,
          updateId: typeof ctx.update.update_id === "number" ? ctx.update.update_id : undefined,
        },
        "telegram guest turn not admitted",
      );
    };
    if (!guestMessage) {
      recordDrop("message-missing");
      return;
    }
    if (!guestQueryId) {
      recordDrop("guest-query-id-missing");
      return;
    }
    if (!caller || !senderId) {
      recordDrop("caller-missing");
      return;
    }
    if (!callerChat || chatId === undefined) {
      recordDrop("chat-missing");
      return;
    }
    const numericChatId = typeof chatId === "number" ? chatId : Number(chatId);
    if (!Number.isSafeInteger(numericChatId)) {
      recordDrop("chat-id-invalid");
      return;
    }
    const isGroup = callerChat.type === "group" || callerChat.type === "supergroup";
    const authorization = resolveTelegramCommandAuthorization({
      cfg,
      accountId,
      chatId: numericChatId,
      isGroup,
      threadSpec: resolveTelegramMessageThreadSpec({
        chat: { id: numericChatId, type: isGroup ? "group" : "private" },
        message_id: Number(guestMessage.message_id ?? 0),
        date: 0,
      } as never),
      senderId,
      senderUsername: textValue(caller.username) || undefined,
      commandAuthorized: true,
    });
    if (!authorization.senderIsOwner || !authorization.isAuthorizedSender) {
      recordDrop("caller-unauthorized");
      return;
    }

    pruneGuestDedupe(Date.now());
    const key = `${accountId}\u0000${senderId}\u0000${guestQueryId}`;
    if (guestDedupe.has(key)) {
      recordDrop("duplicate-query");
      return;
    }
    if (guestDedupe.size >= GUEST_DEDUPE_MAX_ENTRIES) {
      recordDrop("capacity-exceeded");
      try {
        await guestCtx.answerGuestQuery(
          guestResult({
            message: guestMessage,
            answer: GUEST_FAILURE_TEXT,
            botUsername: guestCtx.me?.username,
          }),
        );
      } catch (error) {
        logger.warn(
          { error: String(error), guestQueryHash: guestQueryHash(guestQueryId).slice(0, 24) },
          "telegram guest capacity response failed",
        );
      }
      return;
    }
    const entry: GuestDedupeEntry = {
      expiresAt: Number.POSITIVE_INFINITY,
      work: Promise.resolve(),
      answered: false,
    };
    const work = (async () => {
      try {
        const syntheticMessage = messagePipeline.buildSyntheticTextMessage({
          base: guestMessage as never,
          text: guestPrompt({ message: guestMessage, botUsername: guestCtx.me?.username }),
        });
        const syntheticCtx = messagePipeline.buildSyntheticContext(
          guestCtx as never,
          syntheticMessage,
        );
        let attempted = false;
        let answered = false;
        const responseTarget: TelegramAlternateFinalResponseTarget = {
          deliver: async (text) => {
            if (attempted) {
              return answered;
            }
            attempted = true;
            const accepted = await guestCtx.answerGuestQuery(
              guestResult({
                message: guestMessage,
                answer: text,
                botUsername: guestCtx.me?.username,
              }),
            );
            const delivered = accepted !== false;
            if (delivered) {
              answered = true;
              entry.answered = true;
              entry.expiresAt = Date.now() + GUEST_DEDUPE_TTL_MS;
            }
            return delivered;
          },
        };
        const deliverFailure = async () => {
          if (answered || attempted) {
            return;
          }
          await responseTarget.deliver(GUEST_FAILURE_TEXT);
        };
        const result = await messagePipeline.processMessageWithReplyChain({
          ctx: syntheticCtx,
          msg: syntheticMessage,
          allMedia: [],
          // Carry the owner-authorized Guest sender through ordinary DM admission.
          storeAllowFrom: [senderId],
          options: {
            responseTarget,
          },
        });
        if (result.kind !== "completed") {
          recordDrop(`result-${result.kind}`);
          await deliverFailure();
          return;
        }
        await deliverFailure();
      } catch (error) {
        logger.warn(
          { error: String(error), guestQueryHash: guestQueryHash(guestQueryId).slice(0, 24) },
          "telegram guest turn failed",
        );
        try {
          if (!entry.answered) {
            const accepted = await guestCtx.answerGuestQuery(
              guestResult({
                message: guestMessage,
                answer: GUEST_FAILURE_TEXT,
                botUsername: guestCtx.me?.username,
              }),
            );
            if (accepted !== false) {
              entry.answered = true;
              entry.expiresAt = Date.now() + GUEST_DEDUPE_TTL_MS;
            }
          }
        } catch (deliveryError) {
          logger.warn(
            {
              error: String(deliveryError),
              guestQueryHash: guestQueryHash(guestQueryId).slice(0, 24),
            },
            "telegram guest failure response failed",
          );
        }
      } finally {
        if (!entry.answered && guestDedupe.get(key)?.work === entry.work) {
          // A model or Telegram transport failure remains retryable. Once Telegram
          // accepts the result, retain the key so the guest query can never answer twice.
          guestDedupe.delete(key);
        }
      }
    })();
    entry.work = work;
    guestDedupe.set(key, entry);
    await work;
  });
}
