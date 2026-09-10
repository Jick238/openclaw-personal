import type { WorkboardCard, WorkboardExecution } from "@openclaw/workboard-contract";
import { jsonResult } from "openclaw/plugin-sdk/core";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import { redactClaimToken } from "./card-redaction.js";
import type { WorkboardStore } from "./store.js";
import { strictObject } from "./tools-card-mutations.js";

const FRONT_AGENT_ID = "main";
const ORCHESTRATOR_AGENT_ID = "hicks-orchestrator";
const FRONT_BOARD_ID = "hicks-front";
const CLAIM_TTL_SECONDS = 24 * 60 * 60;

function contextOwner(ctx: OpenClawPluginToolContext | undefined): string {
  return ctx?.agentId?.trim() || "main";
}

function requireFrontContext(ctx: OpenClawPluginToolContext | undefined): {
  agentId: string;
  sessionKey: string;
  requesterOrigin: {
    channel: "telegram";
    accountId?: string;
    to: string;
    threadId?: string | number;
  };
} {
  const agentId = contextOwner(ctx);
  const channel = ctx?.deliveryContext?.channel?.trim().toLowerCase();
  const target = ctx?.deliveryContext?.to?.trim() ?? "";
  if (
    agentId !== FRONT_AGENT_ID ||
    ctx?.senderIsOwner !== true ||
    channel !== "telegram" ||
    !target ||
    target.startsWith("telegram:group:")
  ) {
    throw new Error("hicks_delegate requires the owner’s private Telegram Front session.");
  }
  const sessionKey = ctx?.sessionKey?.trim();
  if (!sessionKey) {
    throw new Error("hicks_delegate requires the current Front session key.");
  }
  return {
    agentId,
    sessionKey,
    requesterOrigin: {
      channel: "telegram",
      ...(ctx?.deliveryContext?.accountId ? { accountId: ctx.deliveryContext.accountId } : {}),
      to: target,
      ...(ctx?.deliveryContext?.threadId !== undefined
        ? { threadId: ctx.deliveryContext.threadId }
        : {}),
    },
  };
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new Error(`${field} must be ${max} characters or fewer.`);
  }
  return text;
}

function executionFor(params: {
  card: WorkboardCard;
  sessionKey: string;
  runId: string;
  now: number;
}): WorkboardExecution {
  return {
    id: params.card.execution?.id ?? `${params.card.id}:agent-session`,
    kind: "agent-session",
    mode: "autonomous",
    status: "running",
    sessionKey: params.sessionKey,
    runId: params.runId,
    startedAt: params.now,
    updatedAt: params.now,
  };
}

function orchestratorTask(params: {
  card: WorkboardCard;
  goal: string;
  token: string;
  frontSessionKey: string;
}): string {
  return [
    "You are the Hicks Orchestrator for one admitted Front task.",
    `Workboard parent card: ${params.card.id}`,
    `Claim token: ${params.token}`,
    `Front requester session: ${params.frontSessionKey}`,
    "",
    "The Workboard card and this native child session are the durable admission. Read and claim the parent card with the supplied token, then decompose the goal into bounded child cards.",
    "Use workboard_decompose with completeParent=false and independentChildren=true. Dispatch the resulting independent cards in parallel with native sessions_spawn, assigning configured agent ids and recording every child card before launch. Workers must heartbeat, complete or block their own cards, and include proof.",
    "For terminal proof, use the worker's available terminal tool in its actual workspace; do not pass a Linux /home path to a Windows node. If that terminal boundary is unavailable, record the typed blocker instead of claiming proof.",
    "Do not send Telegram or other owner-facing messages. Do not declare the task complete from model memory. Reconcile child cards and terminal evidence in the parent card, complete the parent exactly once, and leave the Front requester to deliver the only final user message.",
    "",
    `Goal: ${params.goal}`,
  ].join("\n");
}

export type FrontAdmissionInput = {
  api: OpenClawPluginApi;
  store: WorkboardStore;
  agentId: string;
  sessionKey: string;
  goal: string;
  idempotencyKey: string;
  requesterOrigin: {
    channel: "telegram";
    accountId?: string;
    to: string;
    threadId?: string | number;
  };
};

async function assertFrontSessionCurrent(input: FrontAdmissionInput): Promise<void> {
  const payload = await input.api.runtime.gateway.request<{
    session?: {
      key?: unknown;
      agentId?: unknown;
      deliveryContext?: { channel?: unknown; to?: unknown; accountId?: unknown };
    } | null;
  }>("sessions.describe", { key: input.sessionKey });
  const session = payload.session;
  const deliveryTo =
    typeof session?.deliveryContext?.to === "string" ? session.deliveryContext.to : "";
  const deliveryAccountId =
    typeof session?.deliveryContext?.accountId === "string"
      ? session.deliveryContext.accountId
      : undefined;
  if (
    !session ||
    session.key !== input.sessionKey ||
    session.agentId !== FRONT_AGENT_ID ||
    session.deliveryContext?.channel !== "telegram" ||
    deliveryTo !== input.requesterOrigin.to ||
    deliveryAccountId !== input.requesterOrigin.accountId ||
    deliveryTo.startsWith("telegram:group:")
  ) {
    throw new Error("Front requester session changed or is no longer an owner Telegram DM.");
  }
}

async function rollbackSpawnedChild(params: {
  api: OpenClawPluginApi;
  sessionKey: string;
  runId: string;
}): Promise<void> {
  let aborted = false;
  try {
    const result = await params.api.runtime.gateway.request<{ abortedRunId?: unknown }>(
      "sessions.abort",
      { key: params.sessionKey, runId: params.runId, agentId: ORCHESTRATOR_AGENT_ID },
    );
    aborted = result.abortedRunId === params.runId;
  } catch {
    // Deletion below still fences the session where the Gateway can do so.
  }
  try {
    await params.api.runtime.subagent.deleteSession({
      sessionKey: params.sessionKey,
      deleteTranscript: true,
    });
  } catch (error) {
    if (!aborted) {
      throw new Error("native child rollback could not confirm abort or deletion", {
        cause: error,
      });
    }
  }
}

export async function admitFrontTask(input: FrontAdmissionInput) {
  if (input.agentId !== FRONT_AGENT_ID) {
    throw new Error(`Front admission requires agent ${FRONT_AGENT_ID}.`);
  }
  // The Orchestrator owns the durable Workboard claim. The Front session remains
  // the requester binding used for control and delivery, but cannot mutate the
  // execution card with a different owner identity.
  const ownerId = ORCHESTRATOR_AGENT_ID;
  const initial = await input.store.create({
    title: `Hicks task: ${input.goal.slice(0, 160)}`,
    notes: input.goal,
    status: "ready",
    agentId: ORCHESTRATOR_AGENT_ID,
    boardId: FRONT_BOARD_ID,
    requesterSessionKey: input.sessionKey,
    idempotencyKey: input.idempotencyKey,
    tenant: "hicks-front",
  });
  if (initial.sessionKey && initial.runId) {
    return {
      status: "accepted" as const,
      accepted: true as const,
      duplicate: true as const,
      card: redactClaimToken(initial),
      parentSessionKey: input.sessionKey,
      childSessionKey: initial.sessionKey,
      runId: initial.runId,
    };
  }
  if (initial.status === "done" || initial.status === "blocked") {
    throw new Error(`idempotency key already has a terminal Workboard card: ${initial.id}`);
  }

  const claimed = await input.store.claim(
    initial.id,
    { ownerId, ttlSeconds: CLAIM_TTL_SECONDS },
    {
      expectedAuthority: {
        boardId: FRONT_BOARD_ID,
        status: initial.status,
        agentId: ORCHESTRATOR_AGENT_ID,
      },
    },
  );
  const prepared = await input.store.prepareExecutionLaunch(initial.id, {
    requestedSessionKey: `agent:${ORCHESTRATOR_AGENT_ID}:workboard:${initial.id}`,
    now: Date.now(),
    scope: { ownerId, token: claimed.token },
  });
  let spawnedChild: { sessionKey: string; runId: string } | undefined;
  try {
    const created = await input.api.runtime.subagent.spawnVisible({
      agentId: ORCHESTRATOR_AGENT_ID,
      task: orchestratorTask({
        card: prepared.card,
        goal: input.goal,
        token: claimed.token,
        frontSessionKey: input.sessionKey,
      }),
      label: `hicks-orchestrator:${initial.id}`,
      requesterSessionKey: input.sessionKey,
      requesterOrigin: input.requesterOrigin,
    });
    const childSessionKey = created.childSessionKey?.trim() ?? "";
    const runId = created.runId?.trim() ?? "";
    if (created.status !== "accepted" || !childSessionKey || !runId) {
      throw new Error(
        created.error ?? "native orchestrator session was not accepted with a run id",
      );
    }
    spawnedChild = { sessionKey: childSessionKey, runId };
    // The visible-spawn owner registers requester completion before returning.
    // Re-read the parent after that await so a rotated/replaced Front session
    // cannot receive a stale child acceptance.
    await assertFrontSessionCurrent(input);
    // Wall-clock time can move backwards while the Gateway awaits native spawn;
    // keep the CAS acceptance timestamp at or after the prepared launch.
    const acceptedAt = Math.max(Date.now(), prepared.launch.preparedAt);
    const accepted = await input.store.acceptExecutionLaunch(initial.id, {
      expectedLaunch: prepared.launch,
      expectedSessionKey: prepared.launch.requestedSessionKey,
      expectedRunId: prepared.launch.provisionalRunId,
      sessionKey: childSessionKey,
      runId,
      execution: executionFor({
        card: prepared.card,
        sessionKey: childSessionKey,
        runId,
        now: acceptedAt,
      }),
      acceptedAt,
    });
    if (!accepted) {
      throw new Error("Workboard launch changed before native child acceptance.");
    }
    return {
      status: "accepted" as const,
      accepted: true as const,
      duplicate: false as const,
      card: redactClaimToken(accepted),
      parentSessionKey: input.sessionKey,
      childSessionKey,
      runId,
    };
  } catch (error) {
    let rollbackError: unknown;
    if (spawnedChild) {
      try {
        await rollbackSpawnedChild({
          api: input.api,
          sessionKey: spawnedChild.sessionKey,
          runId: spawnedChild.runId,
        });
      } catch (cleanupError) {
        rollbackError = cleanupError;
      }
    }
    await input.store.failPreparedLaunch(initial.id, {
      expectedLaunch: prepared.launch,
      reason: error instanceof Error ? error.message : String(error),
      failedAt: Date.now(),
    });
    if (rollbackError) {
      throw new Error("Front admission failed and native child rollback was unconfirmed.", {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Typed Front admission. It owns the durable Workboard row and invokes the
 * native visible-spawn path so parent/child identity and completion wake are
 * retained. The ordinary Front model turn decides when this typed tool is
 * needed; every call at this boundary is already an actionable owner request.
 */
export function createFrontAdmissionTool(params: {
  api: OpenClawPluginApi;
  context?: OpenClawPluginToolContext;
  store: WorkboardStore;
}): AnyAgentTool {
  return {
    name: "hicks_delegate",
    label: "Hicks Delegate",
    description:
      "Admit one actionable owner task to Hicks Orchestrator. Use this tool for any owner request that requires work outside the current conversational answer; the ordinary Front model turn handles casual conversation. The tool creates the durable Workboard parent and a native child session, then returns immediately with correlation ids.",
    parameters: strictObject({
      goal: Type.String({
        description: "The bounded actionable task for Hicks Orchestrator.",
        minLength: 1,
        maxLength: 4000,
      }),
      idempotencyKey: Type.String({
        description: "Stable key for this user admission; retries return the same card.",
        minLength: 8,
        maxLength: 128,
      }),
    }),
    execute: async (_toolCallId, rawParams) => {
      const { agentId, sessionKey, requesterOrigin } = requireFrontContext(params.context);
      const record = asNonArrayRecord(rawParams);
      const goal = boundedText(record.goal, "goal", 4000);
      const idempotencyKey = boundedText(record.idempotencyKey, "idempotencyKey", 128);
      return jsonResult(
        await admitFrontTask({
          api: params.api,
          store: params.store,
          agentId,
          sessionKey,
          goal,
          idempotencyKey,
          requesterOrigin,
        }),
      );
    },
  };
}
