import type { WorkboardCard } from "@openclaw/workboard-contract";
import type {
  PluginJsonValue,
  PluginSessionActionContext,
  PluginSessionActionResult,
} from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "../api.js";
import { WorkboardCardConflictError, type WorkboardStore } from "./store.js";

const FRONT_AGENT_ID = "main";
const FRONT_BOARD_ID = "hicks-front";
const ORCHESTRATOR_AGENT_ID = "hicks-orchestrator";
const ACTIVE_STATUSES = new Set([
  "triage",
  "backlog",
  "todo",
  "scheduled",
  "ready",
  "running",
  "review",
]);

type ControlPayload = {
  command: "status" | "tasks" | "stop" | "steer";
  args?: string;
};

type TrustedFrontContext = {
  sessionKey: string;
  command: {
    source: "command";
    channel: string;
    chatType?: string;
    accountId?: string;
    senderId?: string;
    senderIsOwner: boolean;
    isAuthorizedSender: boolean;
    to?: string;
  };
};

function readPayload(value: PluginJsonValue | undefined): ControlPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const payload = value as Record<string, unknown>;
  const command = payload.command;
  if (command !== "status" && command !== "tasks" && command !== "stop" && command !== "steer") {
    return null;
  }
  return {
    command,
    ...(typeof payload.args === "string" ? { args: payload.args } : {}),
  };
}

function trustedFrontContext(ctx: PluginSessionActionContext): TrustedFrontContext | null {
  const command = ctx.command;
  const sessionKey = ctx.sessionKey?.trim();
  if (
    !command ||
    command.source !== "command" ||
    !sessionKey ||
    ctx.agentId !== FRONT_AGENT_ID ||
    command.channel !== "telegram" ||
    command.chatType !== "direct" ||
    !command.senderIsOwner ||
    !command.isAuthorizedSender ||
    !command.accountId ||
    !command.senderId ||
    !command.to ||
    command.to.startsWith("telegram:group:")
  ) {
    return null;
  }
  return { sessionKey, command };
}

async function assertCurrentFrontSession(
  api: OpenClawPluginApi,
  authority: TrustedFrontContext,
): Promise<void> {
  const payload = await api.runtime.gateway.request<{
    session?: {
      key?: unknown;
      agentId?: unknown;
      deliveryContext?: { channel?: unknown; to?: unknown; accountId?: unknown };
    } | null;
  }>("sessions.describe", { key: authority.sessionKey });
  const session = payload.session;
  if (
    !session ||
    session.key !== authority.sessionKey ||
    session.agentId !== FRONT_AGENT_ID ||
    session.deliveryContext?.channel !== "telegram" ||
    session.deliveryContext?.to !== authority.command.to ||
    session.deliveryContext?.accountId !== authority.command.accountId ||
    authority.command.to?.startsWith("telegram:group:")
  ) {
    throw new Error("Front requester session changed or is no longer an owner Telegram DM.");
  }
}

function formatCard(card: WorkboardCard): string {
  const execution = card.execution?.status ? ` execution=${card.execution.status}` : "";
  return `${card.id.slice(0, 8)} ${card.status}${execution} ${card.title}`;
}

function cardsForSession(cards: WorkboardCard[], sessionKey: string): WorkboardCard[] {
  return cards
    .filter(
      (card) =>
        card.metadata?.automation?.tenant === "hicks-front" &&
        card.metadata.automation.requesterSessionKey === sessionKey &&
        !card.metadata.archivedAt,
    )
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
}

function childrenOf(cards: WorkboardCard[], parentId: string): WorkboardCard[] {
  return cards.filter((card) => card.metadata?.automation?.createdByCardId === parentId);
}

async function controlFront(
  api: OpenClawPluginApi,
  store: WorkboardStore,
  payload: ControlPayload,
  authority: TrustedFrontContext,
): Promise<PluginSessionActionResult> {
  const cards = await store.list({ boardId: FRONT_BOARD_ID });
  const parents = cardsForSession(cards, authority.sessionKey);
  const activeParent = parents.find((card) => ACTIVE_STATUSES.has(card.status));
  const parent = activeParent ?? parents[0];
  if (!parent) {
    return { ok: false, code: "not_applicable", error: "No bound Hicks Workboard task." };
  }
  if ((payload.command === "steer" || payload.command === "stop") && !activeParent) {
    return { ok: false, code: "not_applicable", error: "No active Hicks Workboard task." };
  }
  if (payload.command === "status") {
    const children = childrenOf(cards, parent.id);
    return {
      ok: true,
      reply: {
        text: [
          formatCard(parent),
          ...(parent.execution?.sessionKey ? [`orchestrator=${parent.execution.sessionKey}`] : []),
          children.length
            ? `workers=${children.length} active=${children.filter((card) => ACTIVE_STATUSES.has(card.status)).length}`
            : "workers=0",
        ].join("\n"),
      },
    };
  }
  if (payload.command === "tasks") {
    const children = childrenOf(cards, parent.id);
    return {
      ok: true,
      reply: { text: [formatCard(parent), ...children.slice(0, 20).map(formatCard)].join("\n") },
    };
  }
  if (payload.command === "steer") {
    const message = payload.args?.trim();
    if (!message) {
      return { ok: false, error: "Usage: /steer <instruction>" };
    }
    const target = parent.execution?.sessionKey ?? parent.sessionKey;
    if (!target) {
      return { ok: false, error: "The Hicks orchestrator has no active session." };
    }
    await assertCurrentFrontSession(api, authority);
    await api.runtime.gateway.request("sessions.steer", {
      key: target,
      agentId: ORCHESTRATOR_AGENT_ID,
      message,
    });
    return { ok: true, reply: { text: "Steering instruction sent to Hicks Orchestrator." } };
  }
  const target = parent.execution?.sessionKey ?? parent.sessionKey;
  const runId = parent.execution?.runId ?? parent.runId;
  if (target) {
    await assertCurrentFrontSession(api, authority);
    const result = await api.runtime.gateway.request<{
      abortedRunId?: unknown;
      status?: unknown;
    }>("sessions.abort", {
      key: target,
      ...(runId ? { runId } : {}),
      agentId: ORCHESTRATOR_AGENT_ID,
    });
    if (runId && result.abortedRunId !== runId && result.status !== "no-active-run") {
      return { ok: false, error: "The Hicks orchestrator run changed before stop was applied." };
    }
  }
  // Abort is asynchronous; reread both owners before blocking so a replacement run
  // cannot inherit the stop from an earlier execution.
  const latestCards = await store.list({ boardId: FRONT_BOARD_ID });
  const latestParent = latestCards.find((card) => card.id === parent.id);
  if (
    !latestParent ||
    !ACTIVE_STATUSES.has(latestParent.status) ||
    (latestParent.execution?.sessionKey ?? latestParent.sessionKey) !== target ||
    (latestParent.execution?.runId ?? latestParent.runId) !== runId
  ) {
    return { ok: false, error: "The Hicks Workboard task changed before stop was committed." };
  }
  await assertCurrentFrontSession(api, authority);
  try {
    await store.block(parent.id, { reason: "Stopped by Hicks Front owner." }, null, {
      clearExecutionAssociation: true,
      expectedUpdatedAt: latestParent.updatedAt,
    });
  } catch (error) {
    if (error instanceof WorkboardCardConflictError) {
      return { ok: false, error: "The Hicks Workboard task changed before stop was committed." };
    }
    throw error;
  }
  return { ok: true, reply: { text: "Hicks task stopped." } };
}

export function registerFrontControlAction(params: {
  api: OpenClawPluginApi;
  store: WorkboardStore;
}) {
  params.api.registerSessionAction({
    id: "front-control",
    description: "Owner controls for the Hicks Front Workboard execution.",
    commandNames: ["status", "tasks", "stop", "steer"],
    handler: async (ctx) => {
      const payload = readPayload(ctx.payload);
      const authority = trustedFrontContext(ctx);
      if (!payload || !authority) {
        return { ok: false, code: "not_applicable", error: "Incomplete Hicks Front context." };
      }
      return await controlFront(params.api, params.store, payload, authority);
    },
  });
}
