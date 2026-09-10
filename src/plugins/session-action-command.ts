import type { HandleCommandsParams } from "../auto-reply/reply/commands-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import type {
  PluginJsonValue,
  PluginSessionActionContext,
  PluginSessionActionResult,
} from "./types.js";

type CommandPayload = {
  command: string;
  args?: string;
};

function readCommandName(commandBody: string): { name: string; args?: string } | null {
  const match = commandBody.trim().match(/^\/\s*([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
  if (!match?.[1]) {
    return null;
  }
  return { name: match[1].toLowerCase(), ...(match[2]?.trim() ? { args: match[2].trim() } : {}) };
}

function buildPayload(parsed: { name: string; args?: string }): PluginJsonValue {
  const command: CommandPayload = {
    command: parsed.name,
    ...(parsed.args ? { args: parsed.args } : {}),
  };
  return command as unknown as PluginJsonValue;
}

/**
 * Dispatches an exact built-in command to a trusted bundled plugin action.
 * This keeps command parsing in core while the owning plugin retains policy
 * and execution; absent a matching action, normal built-in behavior remains.
 */
export async function dispatchPluginSessionActionCommand(
  params: HandleCommandsParams,
): Promise<PluginSessionActionResult | null> {
  const parsed = readCommandName(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  const registry = getActivePluginRegistry();
  const registration = registry?.sessionActions.find(
    (entry) =>
      entry.origin === "bundled" &&
      registry.plugins.some(
        (plugin) => plugin.id === entry.pluginId && plugin.status === "loaded",
      ) &&
      entry.action.commandNames?.some((name) => name.trim().toLowerCase() === parsed.name),
  );
  if (!registration) {
    return null;
  }
  const context: PluginSessionActionContext = {
    pluginId: registration.pluginId,
    actionId: registration.action.id,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    command: {
      source: "command",
      channel: params.command.channel,
      ...(params.ctx.ChatType ? { chatType: params.ctx.ChatType } : {}),
      ...(params.command.channelId ? { channelId: params.command.channelId } : {}),
      ...(params.command.accountId ? { accountId: params.command.accountId } : {}),
      ...(params.command.senderId ? { senderId: params.command.senderId } : {}),
      senderIsOwner: params.command.senderIsOwner,
      isAuthorizedSender: params.command.isAuthorizedSender,
      ...(params.command.from ? { from: params.command.from } : {}),
      ...(params.command.to ? { to: params.command.to } : {}),
    },
    payload: buildPayload(parsed),
  };
  return (await registration.action.handler(context)) ?? { ok: true };
}
