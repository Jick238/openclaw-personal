/** Lazy runtime adapter for plugin-owned embedded-agent execution. */
import { randomUUID } from "node:crypto";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { log } from "../../agents/embedded-agent-runner/logger.js";
import { createDeferredEmbeddedRunLifecycleManager } from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import { runEmbeddedAgent as runEmbeddedAgentCore } from "../../agents/embedded-agent.js";
import { recordRuntimeActionDecision } from "../../audit/runtime-action-decision.js";
import type {
  ChannelExternalTurnRequest,
  ChannelExternalTurnResult,
} from "../../channels/plugins/channel-runtime-surface.types.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import type { PluginRuntime } from "./types.js";

type PluginEmbeddedAgentInternalOptions = {
  deferAdmissionCloseUntil?: Promise<void>;
};

const runPluginEmbeddedAgentOwned = async (
  params: Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0],
  options?: PluginEmbeddedAgentInternalOptions,
) => {
  const pluginId = getPluginRuntimeGatewayRequestScope()?.pluginId;
  if (!pluginId) {
    throw new Error("Plugin embedded-agent execution requires an active plugin runtime scope.");
  }
  params.abortSignal?.throwIfAborted();
  const decisionOccurrenceId = randomUUID();
  let admittedRunContext: AdmittedRunContext | undefined;
  const preparedRunAdmission = prepareAgentRunAdmission({
    cfg: params.config ?? getRuntimeConfig(),
    operationalRunInstance: createOperationalRunInstanceRef(params.runId),
    facts: {
      runId: params.runId,
      agentId: params.sessionTarget?.agentId ?? params.agentId ?? "main",
      ingress: {
        kind: "plugin",
        boundary: "plugin-runtime",
        rawSourceRef: pluginId,
        state: "present",
      },
    },
    onAdmitted: (context) => {
      admittedRunContext = context;
      const token = context.executionIdentityToken;
      recordRuntimeActionDecision({
        token,
        family: "plugin",
        operation: "run",
        outcome: "allowed",
        coverageState: "enforced",
        reasonCode: "plugin_runtime_owner_admitted",
        owner: "plugin-runtime",
        decisionBoundary: "plugin.runtime.run-embedded-agent",
        policyRefs: ["plugin:registered-owner", "run:admission"],
        summary: "The registered plugin owner passed exact run admission.",
        remediation: [],
        discriminator: JSON.stringify([pluginId, params.runId, decisionOccurrenceId, "admission"]),
      });
    },
  });
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      preparedRunAdmission.close();
    }
  };
  // Abort owns authority revocation independently of core completion; the
  // post-registration check closes the prepare-to-listener race.
  params.abortSignal?.addEventListener("abort", close, { once: true });
  try {
    params.abortSignal?.throwIfAborted();
    const result = await runEmbeddedAgentCore({ ...params, preparedRunAdmission });
    if (admittedRunContext && getAdmittedRunDelegatedAuthority(admittedRunContext)) {
      recordRuntimeActionDecision({
        token: admittedRunContext.executionIdentityToken,
        family: "plugin",
        operation: "run",
        outcome: "allowed",
        coverageState: "attribution-only",
        reasonCode: "plugin_runtime_completed",
        owner: "plugin-runtime",
        decisionBoundary: "plugin.runtime.run-embedded-agent",
        summary: "The plugin-owned runtime completed; this is attribution, not authorization.",
        remediation: [],
        discriminator: JSON.stringify([pluginId, params.runId, decisionOccurrenceId, "completion"]),
      });
    }
    return result;
  } finally {
    params.abortSignal?.removeEventListener("abort", close);
    if (options?.deferAdmissionCloseUntil && !params.abortSignal?.aborted) {
      void options.deferAdmissionCloseUntil.finally(close);
    } else {
      close();
    }
  }
};

export const runPluginEmbeddedAgent: PluginRuntime["agent"]["runEmbeddedAgent"] = async (
  params,
) => {
  if (
    "admittedRunContext" in params ||
    "preparedRunAdmission" in params ||
    "compactionCountOwner" in params ||
    "onCompactionAccounting" in params ||
    "onContextAccountingEvent" in params ||
    "onDeferredLifecycleOwner" in params ||
    "onDeferredLifecycleAbort" in params
  ) {
    throw new Error("Plugin embedded-agent execution cannot supply host run authority.");
  }
  return await runPluginEmbeddedAgentOwned(params);
};

/**
 * Result-only owner for external channel callbacks. It deliberately disables
 * normal message delivery so the transport owns the one terminal response.
 */
export const runPluginEmbeddedAgentForResult = async (
  request: ChannelExternalTurnRequest,
): Promise<ChannelExternalTurnResult> => {
  const config = getRuntimeConfig();
  const agentId = request.agentId ?? "main";
  const runId = randomUUID();
  const storePath = resolveSessionStorePathCore(config.session?.store, { agentId });
  const sessionId =
    loadSessionEntryReadOnly({
      agentId,
      sessionKey: request.sessionKey,
      storePath,
      readConsistency: "latest",
    })?.sessionId ?? randomUUID();
  const controller = new AbortController();
  const deferredLifecycle = createDeferredEmbeddedRunLifecycleManager({
    runId,
    sessionId,
    sessionKey: request.sessionKey,
    abortSignal: controller.signal,
  });
  let releaseAdmission!: () => void;
  const lifecycleSettled = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  let timedOut = false;
  const timer =
    request.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, request.timeoutMs);
  timer?.unref?.();
  const abort = () => controller.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await runPluginEmbeddedAgentOwned(
      {
        config,
        agentId,
        sessionId,
        sessionKey: request.sessionKey,
        sessionTarget: {
          agentId,
          sessionId,
          sessionKey: request.sessionKey,
          storePath,
        },
        workspaceDir: resolveAgentWorkspaceDir(config, agentId),
        prompt: request.prompt,
      ...(request.timeoutMs === undefined
        ? {}
        : { timeoutMs: request.timeoutMs, runTimeoutOverrideMs: request.timeoutMs }),
        runId,
        messageChannel: request.channel,
        messageProvider: request.channel,
        agentAccountId: request.accountId,
        senderId: request.senderId,
        senderUsername: request.senderUsername,
        senderIsOwner: request.senderIsOwner,
        messageTo: `${request.channel}:${request.senderId}`,
        currentChannelId: request.currentChannelId,
        currentMessagingTarget: request.currentMessagingTarget,
        trigger: "user",
        sourceReplyDeliveryMode: "message_tool_only",
        disableMessageTool: true,
        terminalReplyExpectation: "required",
        suppressLiveStreamOutput: true,
        abortSignal: deferredLifecycle.signal,
        deferTerminalLifecycle: true,
        onDeferredLifecycleOwner: deferredLifecycle.adopt,
        onDeferredLifecycleAbort: deferredLifecycle.abort,
      },
      { deferAdmissionCloseUntil: lifecycleSettled },
    );
    const payloads = result.payloads ?? [];
    if (payloads.some((payload) => payload.isError)) {
      return { kind: "error", code: "failed" };
    }
    const text = payloads
      .filter((payload) => !payload.isCommentary && !payload.isError)
      .map((payload) => payload.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n\n")
      .trim();
    return text ? { kind: "completed", text } : { kind: "empty" };
  } catch {
    if (timedOut) {
      return { kind: "timeout" };
    }
    return {
      kind: "error",
      code: request.signal?.aborted || controller.signal.aborted ? "aborted" : "failed",
    };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    request.signal?.removeEventListener("abort", abort);
    void deferredLifecycle
      .complete()
      .catch((error) => {
        log.warn(`plugin result-only deferred lifecycle cleanup failed: runId=${runId}`, { error });
      })
      .finally(releaseAdmission);
  }
};
