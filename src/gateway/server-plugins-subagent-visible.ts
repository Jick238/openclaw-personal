import type { PluginRuntime } from "../plugins/runtime/types.js";

/** Runs the native visible-spawn owner, including requester completion tracking. */
export async function spawnVisiblePluginSubagent(
  params: Parameters<PluginRuntime["subagent"]["spawnVisible"]>[0],
): Promise<Awaited<ReturnType<PluginRuntime["subagent"]["spawnVisible"]>>> {
  const { maybeSpawnVisibleSession } = await import("../agents/tools/sessions-spawn-visible.js");
  const result = await maybeSpawnVisibleSession({
    raw: { visible: true },
    task: params.task,
    label: params.label,
    runtime: "subagent",
    requestedAgentId: params.agentId,
    sandbox: "inherit",
    options: {
      agentSessionKey: params.requesterSessionKey,
      completionOwnerKey: params.requesterSessionKey,
      agentChannel: params.requesterOrigin.channel,
      ...(params.requesterOrigin.accountId
        ? { agentAccountId: params.requesterOrigin.accountId }
        : {}),
      agentTo: params.requesterOrigin.to,
      currentMessagingTarget: params.requesterOrigin.to,
      ...(params.requesterOrigin.threadId !== undefined
        ? { currentThreadTs: String(params.requesterOrigin.threadId) }
        : {}),
    },
  });
  if (!result) {
    return { status: "unavailable", error: "visible spawn returned no result" };
  }
  return {
    status: typeof result.status === "string" ? result.status : "error",
    ...(typeof result.childSessionKey === "string"
      ? { childSessionKey: result.childSessionKey }
      : {}),
    ...(typeof result.runId === "string" ? { runId: result.runId } : {}),
    ...(typeof result.error === "string" ? { error: result.error.slice(0, 512) } : {}),
  };
}
