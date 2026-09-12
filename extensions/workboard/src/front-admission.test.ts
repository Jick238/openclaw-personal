import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { admitFrontTask, createFrontAdmissionTool } from "./front-admission.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore<T = unknown>() {
  const entries = new Map<string, T>();
  return {
    async register(key: string, value: T) {
      entries.set(key, value);
    },
    async lookup(key: string) {
      return entries.get(key);
    },
    async delete(key: string) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].map(([key, value]) => ({ key, value }));
    },
  };
}

function ownerContext(requestGroupId?: string) {
  return {
    agentId: "main",
    senderIsOwner: true,
    deliveryContext: { channel: "telegram", accountId: "work", to: "telegram:42" },
    sessionKey: "agent:main:telegram:direct:42",
    ...(requestGroupId ? { toolBindings: { "workboard.requestGroupId": requestGroupId } } : {}),
  } satisfies OpenClawPluginToolContext;
}

function integrationApi(params: {
  spawnVisible: ReturnType<typeof vi.fn>;
  describe?: () => Promise<unknown>;
  abort?: ReturnType<typeof vi.fn>;
  deleteSession?: ReturnType<typeof vi.fn>;
}) {
  return {
    runtime: {
      subagent: {
        spawnVisible: params.spawnVisible,
        deleteSession: params.deleteSession ?? vi.fn().mockResolvedValue(undefined),
      },
      gateway: {
        request: vi.fn(async (method: string) => {
          if (method === "sessions.describe") {
            return await (params.describe?.() ??
              Promise.resolve({
                session: {
                  key: "agent:main:telegram:direct:42",
                  agentId: "main",
                  deliveryContext: { channel: "telegram", accountId: "work", to: "telegram:42" },
                },
              }));
          }
          if (method === "sessions.abort") {
            params.abort?.();
            return { abortedRunId: "run-orchestrator" };
          }
          throw new Error(`unexpected gateway method ${method}`);
        }),
      },
    },
  } as unknown as OpenClawPluginApi;
}

function makeTool(context: OpenClawPluginToolContext) {
  const store = {
    create: vi.fn(),
  };
  const api = {} as OpenClawPluginApi;
  return { tool: createFrontAdmissionTool({ api, context, store: store as never }), store };
}

describe("hicks_delegate admission boundary", () => {
  it("rejects a non-owner even when the session is the main Telegram DM", async () => {
    const { tool, store } = makeTool({
      agentId: "main",
      senderIsOwner: false,
      messageChannel: "telegram",
      deliveryContext: { channel: "telegram", to: "telegram:123" },
      sessionKey: "agent:main:telegram:direct:123",
    });

    await expect(
      tool.execute("call", { goal: "do work", idempotencyKey: "owner-deny-1" }),
    ).rejects.toThrow(/private Telegram Front/);
    expect(store.create).not.toHaveBeenCalled();
  });

  it("rejects a group route even when the sender is the owner", async () => {
    const { tool, store } = makeTool({
      agentId: "main",
      senderIsOwner: true,
      messageChannel: "telegram",
      deliveryContext: { channel: "telegram", to: "telegram:group:-100" },
      sessionKey: "agent:main:telegram:group:-100",
    });

    await expect(
      tool.execute("call", { goal: "do work", idempotencyKey: "group-deny-1" }),
    ).rejects.toThrow(/private Telegram Front/);
    expect(store.create).not.toHaveBeenCalled();
  });

  it("admits the owner path through native visible spawn with the requester identity", async () => {
    const spawnVisible = vi.fn().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:hicks-orchestrator:dashboard:1",
      runId: "run-orchestrator",
    });
    const store = new WorkboardStore(createMemoryStore());
    const api = integrationApi({ spawnVisible });
    const tool = createFrontAdmissionTool({ api, context: ownerContext(), store });

    const result = await tool.execute("call", {
      goal: "fan out three independent checks",
      idempotencyKey: "owner-positive-1",
    });

    expect(result).toMatchObject({
      content: [expect.objectContaining({ type: "text" })],
    });
    expect(JSON.parse(String(result.content[0]?.text))).toMatchObject({
      status: "accepted",
      runId: "run-orchestrator",
      childSessionKey: "agent:hicks-orchestrator:dashboard:1",
    });
    expect(spawnVisible).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "hicks-orchestrator",
        requesterSessionKey: "agent:main:telegram:direct:42",
        requesterOrigin: { channel: "telegram", accountId: "work", to: "telegram:42" },
        task: expect.stringContaining("sessions_spawn"),
      }),
    );
    expect(spawnVisible.mock.calls[0]?.[0]?.task).toContain("Audit every child blocker");
    expect(spawnVisible.mock.calls[0]?.[0]?.task).toContain(
      "installer merely starting is not proof",
    );
    const [parent] = await store.list();
    expect(parent?.metadata?.claim?.ownerId).toBe("hicks-orchestrator");
    await expect(store.block(parent!.id, {}, { ownerId: "main" })).rejects.toThrow(/claimed by/);
  });

  it("admits independent requester tasks while the first parent is active", async () => {
    const spawnVisible = vi
      .fn()
      .mockResolvedValueOnce({
        status: "accepted",
        childSessionKey: "agent:hicks-orchestrator:dashboard:parallel-1",
        runId: "run-parallel-1",
      })
      .mockResolvedValueOnce({
        status: "accepted",
        childSessionKey: "agent:hicks-orchestrator:dashboard:parallel-2",
        runId: "run-parallel-2",
      });
    const store = new WorkboardStore(createMemoryStore());
    const api = integrationApi({ spawnVisible });
    const tool = createFrontAdmissionTool({ api, context: ownerContext(), store });

    await expect(
      tool.execute("call", { goal: "first bounded audit", idempotencyKey: "parallel-owner-1" }),
    ).resolves.toMatchObject({ content: [expect.objectContaining({ type: "text" })] });
    await expect(
      tool.execute("call", { goal: "second bounded audit", idempotencyKey: "parallel-owner-2" }),
    ).resolves.toMatchObject({ content: [expect.objectContaining({ type: "text" })] });

    expect((await store.list()).filter((card) => card.status === "running")).toHaveLength(2);
  });

  it("groups related Front admissions into one parent and one native wake", async () => {
    const spawnVisible = vi.fn().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:hicks-orchestrator:dashboard:group",
      runId: "run-group",
    });
    const store = new WorkboardStore(createMemoryStore());
    const api = integrationApi({ spawnVisible });
    const context = ownerContext("channel-user:v1:group-1");
    const tool = createFrontAdmissionTool({ api, context, store });

    await Promise.all([
      tool.execute("event-call", { goal: "create the event", idempotencyKey: "group-event-1" }),
      tool.execute("reminder-call", {
        goal: "create the reminder",
        idempotencyKey: "group-reminder-1",
      }),
    ]);
    const cards = await store.list();
    const parents = cards.filter((card) => !card.metadata?.automation?.createdByCardId);
    const children = cards.filter((card) => card.metadata?.automation?.createdByCardId);

    expect(spawnVisible).toHaveBeenCalledOnce();
    expect(parents).toHaveLength(1);
    expect(children).toHaveLength(1);
    expect(children[0]?.metadata?.automation?.requestGroupId).toBe("channel-user:v1:group-1");
    expect([parents[0]?.notes, children[0]?.notes]).toEqual(
      expect.arrayContaining(["create the event", "create the reminder"]),
    );
    expect(parents[0]?.metadata?.automation?.createdCardIds).toEqual([children[0]?.id]);
  });

  it("keeps a terminal grouped child idempotent and preserves independent groups", async () => {
    const spawnVisible = vi
      .fn()
      .mockResolvedValueOnce({
        status: "accepted",
        childSessionKey: "agent:hicks-orchestrator:dashboard:group-a",
        runId: "run-group-a",
      })
      .mockResolvedValueOnce({
        status: "accepted",
        childSessionKey: "agent:hicks-orchestrator:dashboard:group-b",
        runId: "run-group-b",
      });
    const store = new WorkboardStore(createMemoryStore());
    const api = integrationApi({ spawnVisible });
    const first = createFrontAdmissionTool({ api, context: ownerContext("group-a"), store });
    const second = createFrontAdmissionTool({ api, context: ownerContext("group-b"), store });

    await first.execute("call", { goal: "event", idempotencyKey: "group-a-event" });
    const grouped = await first.execute("call", {
      goal: "reminder",
      idempotencyKey: "group-a-reminder",
    });
    const groupedPayload = JSON.parse(String(grouped.content[0]?.text)) as {
      childCard?: { id?: string };
    };
    const childId = groupedPayload.childCard?.id;
    expect(childId).toBeTruthy();
    const childClaim = await store.claim(childId!, { ownerId: "worker" });
    await store.complete(
      childId!,
      { summary: "terminal child" },
      { ownerId: "worker", token: childClaim.token },
    );
    await first.execute("call", { goal: "reminder", idempotencyKey: "group-a-reminder" });
    await second.execute("call", { goal: "independent", idempotencyKey: "group-b-event" });

    const cards = await store.list();
    expect(spawnVisible).toHaveBeenCalledTimes(2);
    expect(cards.filter((card) => !card.metadata?.automation?.createdByCardId)).toHaveLength(2);
    expect(
      cards.filter((card) => card.metadata?.automation?.requestGroupId === "group-a"),
    ).toHaveLength(2);
  });

  it("reuses the durable card when the same inline admission is retried", async () => {
    const spawnVisible = vi.fn().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:hicks-orchestrator:dashboard:retry",
      runId: "run-retry",
    });
    const store = new WorkboardStore(createMemoryStore());
    const api = integrationApi({ spawnVisible });
    const input = {
      api,
      store,
      agentId: "main",
      sessionKey: ownerContext().sessionKey,
      goal: "проверь сервер",
      idempotencyKey: "inline:telegram-query-retry",
      requesterOrigin: { channel: "telegram" as const, accountId: "work", to: "telegram:42" },
    };

    const first = await admitFrontTask(input);
    const retriedAfterOwnerRecreation = await admitFrontTask(input);
    expect(first.duplicate).toBe(false);
    expect(retriedAfterOwnerRecreation).toMatchObject({
      duplicate: true,
      card: { id: first.card.id },
    });
    expect(spawnVisible).toHaveBeenCalledOnce();
  });

  it("keeps native child acceptance monotonic when the wall clock moves backwards", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const spawnVisible = vi.fn().mockImplementation(async () => {
      now = 900;
      return {
        status: "accepted",
        childSessionKey: "agent:hicks-orchestrator:dashboard:clock",
        runId: "run-clock",
      };
    });
    const store = new WorkboardStore(createMemoryStore());
    const api = integrationApi({ spawnVisible });
    const tool = createFrontAdmissionTool({ api, context: ownerContext(), store });
    try {
      await expect(
        tool.execute("call", {
          goal: "preserve acceptance under clock regression",
          idempotencyKey: "owner-clock-regression-1",
        }),
      ).resolves.toMatchObject({ content: [expect.objectContaining({ type: "text" })] });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([
    ["parent revalidation", { describe: () => Promise.reject(new Error("session rotated")) }],
    ["acceptance CAS", { acceptFalse: true }],
  ])("aborts and deletes a child after %s failure", async (_label, options) => {
    const spawnVisible = vi.fn().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:hicks-orchestrator:dashboard:1",
      runId: "run-orchestrator",
    });
    const abort = vi.fn();
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const store = new WorkboardStore(createMemoryStore());
    if (options.acceptFalse) {
      vi.spyOn(store, "acceptExecutionLaunch").mockResolvedValue(undefined);
    }
    const api = integrationApi({ spawnVisible, describe: options.describe, abort, deleteSession });
    const tool = createFrontAdmissionTool({ api, context: ownerContext(), store });

    await expect(
      tool.execute("call", {
        goal: "must roll back if acceptance changes",
        idempotencyKey: `rollback-${_label.replaceAll(" ", "-")}`,
      }),
    ).rejects.toThrow();
    expect(abort).toHaveBeenCalledOnce();
    expect(deleteSession).toHaveBeenCalledWith({
      sessionKey: "agent:hicks-orchestrator:dashboard:1",
      deleteTranscript: true,
    });
  });
});
