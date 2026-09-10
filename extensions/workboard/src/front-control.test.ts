import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFrontControlAction } from "./front-control.js";
import type { WorkboardStore } from "./store.js";

const card = {
  id: "parent-1234",
  title: "Hicks task: investigate",
  status: "running" as const,
  priority: "normal" as const,
  labels: [],
  position: 0,
  createdAt: 1,
  updatedAt: 2,
  sessionKey: "agent:hicks-orchestrator:workboard:parent-1234",
  runId: "run-1",
  execution: {
    id: "execution-1",
    kind: "agent-session" as const,
    mode: "autonomous" as const,
    status: "running" as const,
    sessionKey: "agent:hicks-orchestrator:workboard:parent-1234",
    runId: "run-1",
    startedAt: 1,
    updatedAt: 2,
  },
  metadata: {
    automation: {
      tenant: "hicks-front",
      boardId: "hicks-front",
      requesterSessionKey: "agent:main:telegram:dm",
    },
  },
};

function setup() {
  const request = vi.fn(async (method: string) =>
    method === "sessions.describe"
      ? {
          session: {
            key: "agent:main:telegram:dm",
            agentId: "main",
            deliveryContext: { channel: "telegram", accountId: "default", to: "telegram:42" },
          },
        }
      : { abortedRunId: "run-1" },
  );
  const list = vi.fn(async () => [card]);
  const block = vi.fn(async () => ({ ...card, status: "blocked" as const }));
  const store = {
    list,
    block,
  } as unknown as WorkboardStore;
  const registerSessionAction = vi.fn();
  const api = {
    registerSessionAction,
    runtime: { gateway: { request } },
  } as never;
  registerFrontControlAction({ api, store });
  const registration = registerSessionAction.mock.calls[0]?.[0];
  if (!registration) {
    throw new Error("front-control action was not registered");
  }
  return { registration, request, store, list, block };
}

const ownerPayload = {
  command: "status",
};

const ownerContext = {
  source: "command" as const,
  channel: "telegram",
  chatType: "direct",
  accountId: "default",
  senderId: "42",
  senderIsOwner: true,
  isAuthorizedSender: true,
  to: "telegram:42",
};

afterEach(() => vi.restoreAllMocks());

describe("Hicks Front Workboard controls", () => {
  it("reads the bound aggregate without a model or Gateway round trip", async () => {
    const { registration, request } = setup();
    await expect(
      registration.handler({
        pluginId: "workboard",
        actionId: "front-control",
        sessionKey: "agent:main:telegram:dm",
        agentId: "main",
        command: ownerContext,
        payload: ownerPayload,
      }),
    ).resolves.toMatchObject({ ok: true, reply: { text: expect.stringContaining("parent-1") } });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a non-owner before reading or mutating Workboard state", async () => {
    const { registration, list } = setup();
    await expect(
      registration.handler({
        pluginId: "workboard",
        actionId: "front-control",
        sessionKey: "agent:main:telegram:dm",
        agentId: "main",
        command: { ...ownerContext, senderIsOwner: false },
        payload: ownerPayload,
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(list).not.toHaveBeenCalled();
  });

  it("returns not_applicable when the Front session has no bound task", async () => {
    const { registration, list } = setup();
    list.mockResolvedValueOnce([]);
    await expect(
      registration.handler({
        pluginId: "workboard",
        actionId: "front-control",
        sessionKey: "agent:main:telegram:dm",
        agentId: "main",
        command: ownerContext,
        payload: ownerPayload,
      }),
    ).resolves.toMatchObject({ ok: false, code: "not_applicable" });
  });

  it("steers and stops the exact bound orchestrator execution", async () => {
    const { registration, request, block } = setup();
    await registration.handler({
      pluginId: "workboard",
      actionId: "front-control",
      sessionKey: "agent:main:telegram:dm",
      agentId: "main",
      command: ownerContext,
      payload: { ...ownerPayload, command: "steer", args: "focus on the failing test" },
    });
    expect(request).toHaveBeenCalledWith(
      "sessions.steer",
      expect.objectContaining({
        key: card.execution.sessionKey,
        agentId: "hicks-orchestrator",
        message: "focus on the failing test",
      }),
    );
    await registration.handler({
      pluginId: "workboard",
      actionId: "front-control",
      sessionKey: "agent:main:telegram:dm",
      agentId: "main",
      command: ownerContext,
      payload: { ...ownerPayload, command: "stop" },
    });
    expect(request).toHaveBeenCalledWith(
      "sessions.abort",
      expect.objectContaining({ runId: "run-1" }),
    );
    expect(block).toHaveBeenCalledWith(card.id, { reason: "Stopped by Hicks Front owner." }, null, {
      clearExecutionAssociation: true,
      expectedUpdatedAt: card.updatedAt,
    });
  });

  it("does not block a card when the abort response names another run", async () => {
    const { registration, request, block } = setup();
    request.mockImplementation(async (method: string) =>
      method === "sessions.describe"
        ? {
            session: {
              key: "agent:main:telegram:dm",
              agentId: "main",
              deliveryContext: {
                channel: "telegram",
                accountId: "default",
                to: "telegram:42",
              },
            },
          }
        : { abortedRunId: "different-run", status: "aborted" },
    );
    await expect(
      registration.handler({
        pluginId: "workboard",
        actionId: "front-control",
        sessionKey: "agent:main:telegram:dm",
        agentId: "main",
        command: ownerContext,
        payload: { ...ownerPayload, command: "stop" },
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(block).not.toHaveBeenCalled();
  });

  it("rejects a forged Gateway invocation even when its payload claims owner access", async () => {
    const { registration, list, request, block } = setup();
    await expect(
      registration.handler({
        pluginId: "workboard",
        actionId: "front-control",
        sessionKey: "agent:main:telegram:dm",
        agentId: "main",
        payload: {
          command: "stop",
          channel: "telegram",
          senderIsOwner: true,
          isAuthorizedSender: true,
          to: "telegram:42",
        },
      }),
    ).resolves.toMatchObject({ ok: false, code: "not_applicable" });
    expect(list).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(block).not.toHaveBeenCalled();
  });

  it("does not steer or stop after the Front session delivery changes", async () => {
    const { registration, request, block } = setup();
    request.mockImplementation(async (method: string) =>
      method === "sessions.describe"
        ? {
            session: {
              key: "agent:main:telegram:dm",
              agentId: "main",
              deliveryContext: { channel: "telegram", accountId: "default", to: "telegram:other" },
            },
          }
        : { abortedRunId: "run-1" },
    );
    await expect(
      registration.handler({
        pluginId: "workboard",
        actionId: "front-control",
        sessionKey: "agent:main:telegram:dm",
        agentId: "main",
        command: ownerContext,
        payload: { command: "steer", args: "do not send" },
      }),
    ).rejects.toThrow("Front requester session changed");
    expect(request).toHaveBeenCalledWith("sessions.describe", {
      key: "agent:main:telegram:dm",
    });
    expect(block).not.toHaveBeenCalled();
  });

  it("revalidates owner delivery again before committing a stop", async () => {
    const { registration, request, block } = setup();
    let describes = 0;
    request.mockImplementation(async (method: string) => {
      if (method === "sessions.describe") {
        describes += 1;
        return {
          session: {
            key: "agent:main:telegram:dm",
            agentId: "main",
            deliveryContext:
              describes === 1
                ? { channel: "telegram", accountId: "default", to: "telegram:42" }
                : { channel: "telegram", accountId: "default", to: "telegram:other" },
          },
        };
      }
      return { abortedRunId: "run-1" };
    });
    await expect(
      registration.handler({
        pluginId: "workboard",
        actionId: "front-control",
        sessionKey: "agent:main:telegram:dm",
        agentId: "main",
        command: ownerContext,
        payload: { command: "stop" },
      }),
    ).rejects.toThrow("Front requester session changed");
    expect(describes).toBe(2);
    expect(block).not.toHaveBeenCalled();
  });

  it("fences a replacement card between the final read and stop commit", async () => {
    const { registration, block } = setup();
    block.mockImplementation(async (_id, _input, _scope, options) => {
      if (options?.expectedUpdatedAt !== card.updatedAt) {
        throw new Error("missing execution CAS");
      }
      throw new Error("replacement run won the store race");
    });
    await expect(
      registration.handler({
        pluginId: "workboard",
        actionId: "front-control",
        sessionKey: "agent:main:telegram:dm",
        agentId: "main",
        command: ownerContext,
        payload: { command: "stop" },
      }),
    ).rejects.toThrow("replacement run won the store race");
    expect(block).toHaveBeenCalledWith(card.id, { reason: "Stopped by Hicks Front owner." }, null, {
      clearExecutionAssociation: true,
      expectedUpdatedAt: card.updatedAt,
    });
  });
});
