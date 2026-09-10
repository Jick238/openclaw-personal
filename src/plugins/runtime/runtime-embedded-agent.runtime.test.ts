import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import { configureRuntimeActionDecisionSink } from "../../audit/runtime-action-decision.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimePluginIdScope } from "./gateway-request-scope.js";
import type { PluginRuntime } from "./types.js";

const mocks = vi.hoisted(() => ({
  authorityActive: true,
  close: vi.fn(),
  createOperationalRunInstanceRef: vi.fn((runId: string) => ({
    instanceId: `instance:${runId}`,
    runId,
  })),
  getRuntimeConfig: vi.fn(() => ({}) as OpenClawConfig),
  loadSessionEntryReadOnly: vi.fn(),
  prepareAgentRunAdmission: vi.fn(),
  runEmbeddedAgentCore: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../agents/admitted-run-context.js", () => ({
  createOperationalRunInstanceRef: mocks.createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority: vi.fn(() =>
    mocks.authorityActive ? { runId: "run-plugin" } : undefined,
  ),
  prepareAgentRunAdmission: mocks.prepareAgentRunAdmission,
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgentCore,
}));
vi.mock("../../agents/embedded-agent-runner/logger.js", () => ({
  log: { warn: mocks.warn },
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: mocks.getRuntimeConfig }));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntryReadOnly: mocks.loadSessionEntryReadOnly,
}));
vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: vi.fn(() => "/tmp/sessions"),
}));

import {
  runPluginEmbeddedAgent,
  runPluginEmbeddedAgentForResult,
} from "./runtime-embedded-agent.runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const config = {} as OpenClawConfig;
const params = {
  config,
  prompt: "check",
  runId: "run-plugin",
  sessionId: "session-plugin",
  sessionTarget: {
    agentId: "researcher",
    sessionId: "session-plugin",
    sessionKey: "agent:researcher:plugin",
    storePath: "/tmp/sessions",
  },
  timeoutMs: 1,
  workspaceDir: "/tmp/workspace",
} as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];

describe("plugin embedded-agent runtime admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorityActive = true;
    mocks.close.mockImplementation(() => {
      mocks.authorityActive = false;
    });
    mocks.prepareAgentRunAdmission.mockReturnValue({
      operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
      admit: vi.fn(),
      close: mocks.close,
    });
    mocks.runEmbeddedAgentCore.mockResolvedValue({ payloads: [] });
    mocks.loadSessionEntryReadOnly.mockReturnValue(undefined);
  });

  it("returns only final non-commentary text for an external turn", async () => {
    mocks.runEmbeddedAgentCore.mockResolvedValueOnce({
      payloads: [{ text: "thinking", isCommentary: true }, { text: "final answer" }],
    });

    await expect(
      withPluginRuntimePluginIdScope("telegram", () =>
        runPluginEmbeddedAgentForResult({
          channel: "telegram",
          accountId: "default",
          agentId: "main",
          sessionKey: "telegram:inline:default:42",
          prompt: "hello",
          senderId: "42",
          senderIsOwner: true,
          currentChannelId: "telegram:777",
          currentMessagingTarget: "telegram:777",
          timeoutMs: 5_000,
        }),
      ),
    ).resolves.toEqual({ kind: "completed", text: "final answer" });

    expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledWith(
      expect.objectContaining({
        messageChannel: "telegram",
        sourceReplyDeliveryMode: "message_tool_only",
        disableMessageTool: true,
        terminalReplyExpectation: "required",
        senderIsOwner: true,
        messageTo: "telegram:42",
        currentChannelId: "telegram:777",
        currentMessagingTarget: "telegram:777",
        deferTerminalLifecycle: true,
        onDeferredLifecycleOwner: expect.any(Function),
      }),
    );
  });

  it("keeps a Guest result alive past 9s when no caller timeout is supplied", async () => {
    vi.useFakeTimers();
    const core = deferred<{ payloads: Array<{ text: string }> }>();
    mocks.runEmbeddedAgentCore.mockReturnValueOnce(core.promise);
    const run = withPluginRuntimePluginIdScope("telegram", () =>
      runPluginEmbeddedAgentForResult({
        channel: "telegram",
        accountId: "default",
        agentId: "main",
        sessionKey: "telegram:guest:default:42",
        prompt: "slow guest question",
        senderId: "42",
      }),
    );

    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(9_001);
    core.resolve({ payloads: [{ text: "late answer" }] });
    await Promise.resolve();
    expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledWith(
      expect.not.objectContaining({ timeoutMs: expect.anything() }),
    );
    await expect(run).resolves.toEqual({ kind: "completed", text: "late answer" });
    expect(mocks.close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("returns the terminal result before deferred cleanup settles", async () => {
    const cleanup = deferred<void>();
    const cleanupComplete = vi.fn(() => cleanup.promise);
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async (input) => {
      input.onDeferredLifecycleOwner?.({ complete: cleanupComplete, discard: vi.fn() });
      return { payloads: [{ text: "ready before telemetry" }] };
    });

    const run = withPluginRuntimePluginIdScope("telegram", () =>
      runPluginEmbeddedAgentForResult({
        channel: "telegram",
        accountId: "default",
        agentId: "main",
        sessionKey: "telegram:guest:default:42",
        prompt: "hello",
        senderId: "42",
        timeoutMs: 5_000,
      }),
    );

    await expect(run).resolves.toEqual({ kind: "completed", text: "ready before telemetry" });
    expect(cleanupComplete).toHaveBeenCalledOnce();
    expect(mocks.close).not.toHaveBeenCalled();
    cleanup.resolve();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
  });

  it("keeps a completed result when deferred cleanup fails", async () => {
    const cleanupError = new Error("trajectory unavailable");
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async (input) => {
      input.onDeferredLifecycleOwner?.({
        complete: async () => {
          throw cleanupError;
        },
        discard: vi.fn(),
      });
      return { payloads: [{ text: "delivered once" }] };
    });

    await expect(
      withPluginRuntimePluginIdScope("telegram", () =>
        runPluginEmbeddedAgentForResult({
          channel: "telegram",
          accountId: "default",
          sessionKey: "telegram:guest:default:42",
          prompt: "hello",
          senderId: "42",
          timeoutMs: 5_000,
        }),
      ),
    ).resolves.toEqual({ kind: "completed", text: "delivered once" });
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("plugin result-only deferred lifecycle cleanup failed"),
      { error: cleanupError },
    );
  });

  it("uses the current durable session generation for an external turn", async () => {
    mocks.loadSessionEntryReadOnly.mockReturnValue({ sessionId: "current-session" });

    await withPluginRuntimePluginIdScope("telegram", () =>
      runPluginEmbeddedAgentForResult({
        channel: "telegram",
        accountId: "default",
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:42",
        prompt: "arbitrary question",
        senderId: "42",
        timeoutMs: 5_000,
      }),
    );

    expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "current-session",
        sessionTarget: expect.objectContaining({
          sessionId: "current-session",
          sessionKey: "agent:main:telegram:direct:42",
        }),
      }),
    );
  });

  it("classifies runner failures and error payloads instead of returning selectable text", async () => {
    mocks.runEmbeddedAgentCore.mockRejectedValueOnce(new Error("app-server unavailable"));

    await expect(
      withPluginRuntimePluginIdScope("telegram", () =>
        runPluginEmbeddedAgentForResult({
          channel: "telegram",
          accountId: "default",
          agentId: "main",
          sessionKey: "telegram:inline:default:42",
          prompt: "hello",
          senderId: "42",
          timeoutMs: 5_000,
        }),
      ),
    ).resolves.toEqual({ kind: "error", code: "failed" });

    mocks.runEmbeddedAgentCore.mockResolvedValueOnce({
      payloads: [{ text: "provider failed", isError: true }],
    });
    await expect(
      withPluginRuntimePluginIdScope("telegram", () =>
        runPluginEmbeddedAgentForResult({
          channel: "telegram",
          accountId: "default",
          agentId: "main",
          sessionKey: "telegram:inline:default:42",
          prompt: "hello",
          senderId: "42",
          timeoutMs: 5_000,
        }),
      ),
    ).resolves.toEqual({ kind: "error", code: "failed" });
  });

  it("binds plugin facts and closes the exact prepared admission after success", async () => {
    await expect(
      withPluginRuntimePluginIdScope("memory-plugin", () => runPluginEmbeddedAgent(params)),
    ).resolves.toEqual({ payloads: [] });

    expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledWith({
      cfg: config,
      operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
      facts: {
        runId: "run-plugin",
        agentId: "researcher",
        ingress: {
          kind: "plugin",
          boundary: "plugin-runtime",
          rawSourceRef: "memory-plugin",
          state: "present",
        },
      },
      onAdmitted: expect.any(Function),
    });
    expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledWith(
      expect.objectContaining({
        ...params,
        preparedRunAdmission: expect.objectContaining({ close: mocks.close }),
      }),
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("closes the prepared admission when core execution throws", async () => {
    mocks.runEmbeddedAgentCore.mockRejectedValueOnce(new Error("core failed"));

    await expect(
      withPluginRuntimePluginIdScope("memory-plugin", () => runPluginEmbeddedAgent(params)),
    ).rejects.toThrow("core failed");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("records exact admission and attribution-only completion without plugin identifiers", async () => {
    const executionIdentityToken = {
      tokenVersion: 1,
      contextId: "context-plugin",
      executionId: "execution-plugin",
      runId: "run-plugin",
      createdAt: 100,
    } as const;
    const admittedRunContext: AdmittedRunContext = {
      operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
      executionIdentityToken,
    };
    mocks.prepareAgentRunAdmission.mockImplementationOnce(
      (input: { onAdmitted?: (context: AdmittedRunContext) => void | Promise<void> }) => ({
        operationalRunInstance: admittedRunContext.operationalRunInstance,
        admit: async () => {
          await input.onAdmitted?.(admittedRunContext);
          return admittedRunContext;
        },
        close: mocks.close,
      }),
    );
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async (input) => {
      await input.preparedRunAdmission.admit("plugin-harness");
      return { payloads: [] };
    });
    const receipts: DecisionReceiptV1[] = [];
    const clear = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    try {
      await withPluginRuntimePluginIdScope("private-plugin-id", () =>
        runPluginEmbeddedAgent(params),
      );
    } finally {
      clear();
    }
    expect(receipts).toMatchObject([
      {
        decision: { outcome: "allowed", reasonCode: "plugin_runtime_owner_admitted" },
        enforcement: { coverageState: "enforced" },
      },
      {
        decision: { outcome: "allowed", reasonCode: "plugin_runtime_completed" },
        enforcement: { coverageState: "attribution-only" },
      },
    ]);
    expect(JSON.stringify(receipts)).not.toContain("private-plugin-id");
  });

  it("revokes admission immediately when a pending plugin run aborts", async () => {
    const core = deferred<{ payloads: never[] }>();
    const admittedRunContext: AdmittedRunContext = {
      operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
      executionIdentityToken: {
        tokenVersion: 1,
        contextId: "context-plugin-abort",
        executionId: "execution-plugin-abort",
        runId: "run-plugin",
        createdAt: 100,
      },
    };
    mocks.prepareAgentRunAdmission.mockImplementationOnce(
      (input: { onAdmitted?: (context: AdmittedRunContext) => void | Promise<void> }) => ({
        operationalRunInstance: admittedRunContext.operationalRunInstance,
        admit: async () => {
          await input.onAdmitted?.(admittedRunContext);
          return admittedRunContext;
        },
        close: mocks.close,
      }),
    );
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async (input) => {
      await input.preparedRunAdmission.admit("plugin-harness");
      return core.promise;
    });
    const receipts: DecisionReceiptV1[] = [];
    const clear = configureRuntimeActionDecisionSink((receipt) => {
      receipts.push(receipt);
      return true;
    });
    const controller = new AbortController();
    const run = withPluginRuntimePluginIdScope("memory-plugin", () =>
      runPluginEmbeddedAgent({ ...params, abortSignal: controller.signal }),
    );
    try {
      await vi.waitFor(() => expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce());

      controller.abort(new Error("cancelled"));
      expect(mocks.close).toHaveBeenCalledOnce();
      core.resolve({ payloads: [] });
      await expect(run).resolves.toEqual({ payloads: [] });
      expect(mocks.close).toHaveBeenCalledOnce();
      expect(receipts.map((receipt) => receipt.decision.reasonCode)).toEqual([
        "plugin_runtime_owner_admitted",
      ]);
    } finally {
      clear();
    }
  });

  it("closes admission when abort races with listener registration", async () => {
    const controller = new AbortController();
    mocks.prepareAgentRunAdmission.mockImplementationOnce(() => {
      controller.abort(new Error("raced cancellation"));
      return {
        operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
        admit: vi.fn(),
        close: mocks.close,
      };
    });

    await expect(
      withPluginRuntimePluginIdScope("memory-plugin", () =>
        runPluginEmbeddedAgent({ ...params, abortSignal: controller.signal }),
      ),
    ).rejects.toThrow("raced cancellation");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it("does not create admission for an already-aborted plugin run", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));

    await expect(
      withPluginRuntimePluginIdScope("memory-plugin", () =>
        runPluginEmbeddedAgent({ ...params, abortSignal: controller.signal }),
      ),
    ).rejects.toThrow("already cancelled");
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it("fails closed outside a plugin scope", async () => {
    await expect(runPluginEmbeddedAgent(params)).rejects.toThrow("active plugin runtime scope");
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it.each([
    "admittedRunContext",
    "preparedRunAdmission",
    "onDeferredLifecycleOwner",
    "onDeferredLifecycleAbort",
    "compactionCountOwner",
    "onCompactionAccounting",
    "onContextAccountingEvent",
  ] as const)("rejects a plugin-supplied %s", async (field) => {
    const value = field === "compactionCountOwner" ? "caller" : {};
    const input = { ...params, [field]: value };
    await expect(
      withPluginRuntimePluginIdScope("memory-plugin", () => runPluginEmbeddedAgent(input)),
    ).rejects.toThrow("cannot supply host run authority");
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it.each(["compactionCountOwner", "onCompactionAccounting", "onContextAccountingEvent"])(
    "rejects inherited %s before admission",
    async (field) => {
      const input = { ...params };
      Object.setPrototypeOf(input, {
        [field]: field === "compactionCountOwner" ? "caller" : vi.fn(),
      });

      await expect(
        withPluginRuntimePluginIdScope("memory-plugin", () => runPluginEmbeddedAgent(input)),
      ).rejects.toThrow("cannot supply host run authority");
      expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
      expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
    },
  );
});
