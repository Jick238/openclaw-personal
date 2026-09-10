import { dispatchPluginSessionActionCommand } from "../../plugins/session-action-command.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { CommandHandler } from "./commands-types.js";

function readReply(value: unknown): ReplyPayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" ? { text } : undefined;
}

export const handlePluginSessionActionCommand: CommandHandler = async (params) => {
  const result = await dispatchPluginSessionActionCommand(params);
  if (!result) {
    return null;
  }
  if (result.ok === false) {
    if (result.code === "not_applicable") {
      return null;
    }
    return {
      reply: { text: result.error, isError: true },
      shouldContinue: false,
    };
  }
  return {
    ...(readReply(result.reply) ? { reply: readReply(result.reply) } : {}),
    shouldContinue: result.continueAgent === true,
  };
};
