import { afterEach, describe, expect, it, vi } from "vitest";
import type { HandleCommandsParams } from "../auto-reply/reply/commands-types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { dispatchPluginSessionActionCommand } from "./session-action-command.js";
import { createBundledPluginRecord } from "./status.test-fixtures.js";

afterEach(() => resetPluginRuntimeStateForTest());

function params(commandBodyNormalized: string): HandleCommandsParams {
  return {
    ctx: { SessionKey: "agent:main:telegram:dm" },
    command: {
      channel: "telegram",
      commandBodyNormalized,
      rawBodyNormalized: commandBodyNormalized,
      senderIsOwner: true,
      isAuthorizedSender: true,
      ownerList: [],
      surface: "telegram",
      senderId: "42",
    },
    cfg: {},
    directives: {},
    elevated: { enabled: false, allowed: false, failures: [] },
    sessionKey: "agent:main:telegram:dm",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "always",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "test",
    model: "test",
    contextTokens: 0,
    isGroup: false,
  } as HandleCommandsParams;
}

describe("plugin session action command bridge", () => {
  it("dispatches only an exact slash command to a bundled action", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createBundledPluginRecord("workboard"));
    const handler = vi.fn(async () => ({ ok: true as const, reply: { text: "handled" } }));
    registry.sessionActions.push({
      pluginId: "workboard",
      action: { id: "front-control", commandNames: ["status"], handler },
      origin: "bundled",
      source: "bundled:workboard",
    });
    setActivePluginRegistry(registry);

    await expect(dispatchPluginSessionActionCommand(params("/status"))).resolves.toMatchObject({
      ok: true,
      reply: { text: "handled" },
    });
    await expect(
      dispatchPluginSessionActionCommand(params("tell me my status")),
    ).resolves.toBeNull();
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: "agent:main:telegram:dm",
      command: {
        source: "command",
        channel: "telegram",
        senderIsOwner: true,
        isAuthorizedSender: true,
      },
      payload: { command: "status" },
    });
    expect(handler.mock.calls[0]?.[0].payload).not.toHaveProperty("senderIsOwner");
  });

  it("ignores command mappings from an external registration", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({ ...createBundledPluginRecord("workboard"), origin: "workspace" });
    registry.sessionActions.push({
      pluginId: "workboard",
      action: { id: "front-control", commandNames: ["status"], handler: vi.fn() },
      origin: "workspace",
      source: "workspace:workboard",
    });
    setActivePluginRegistry(registry);
    await expect(dispatchPluginSessionActionCommand(params("/status"))).resolves.toBeNull();
  });
});
