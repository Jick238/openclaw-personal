import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./tools/common.js";

const { emitTrustedDiagnosticEventMock, warnMock } = vi.hoisted(() => ({
  emitTrustedDiagnosticEventMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock("../infra/diagnostic-events.js", () => ({
  emitTrustedDiagnosticEvent: emitTrustedDiagnosticEventMock,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: warnMock,
  }),
}));

vi.mock("../plugins/tools.js", () => ({
  getPluginToolMeta: (tool: { name?: string }) =>
    tool.name === "mockplugin_lookup" ? { pluginId: "mockplugin" } : undefined,
}));

import { filterProviderNormalizableRuntimeTools } from "./tool-schema-quarantine.js";

describe("filterProviderNormalizableRuntimeTools", () => {
  beforeEach(() => {
    emitTrustedDiagnosticEventMock.mockClear();
    warnMock.mockClear();
  });

  it("quarantines non-serializable schemas without hiding healthy tools", () => {
    const healthy = {
      name: "mockplugin_lookup",
      label: "Mock Lookup",
      description: "Look up mock data.",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [], details: undefined }),
    } satisfies AnyAgentTool;
    const circularSchema = {
      name: "fuzzplugin_circular_schema",
      label: "Fuzz Circular Schema",
      description: "Expose a circular schema.",
      parameters: {} as { self?: unknown },
      execute: async () => ({ content: [], details: undefined }),
    } satisfies AnyAgentTool & { parameters: { self?: unknown } };
    circularSchema.parameters.self = circularSchema.parameters;

    expect(
      filterProviderNormalizableRuntimeTools({
        tools: [circularSchema, healthy],
        runId: "run-fuzzplugin-quarantine",
        sessionKey: "session-fuzzplugin",
      }),
    ).toEqual([healthy]);
    expect(emitTrustedDiagnosticEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool.execution.blocked",
        runId: "run-fuzzplugin-quarantine",
        sessionKey: "session-fuzzplugin",
        toolName: "fuzzplugin_circular_schema",
        toolSource: "core",
      }),
    );
    expect(String(warnMock.mock.calls[0]?.[0])).toContain(
      "fuzzplugin_circular_schema: fuzzplugin_circular_schema.parameters is not JSON-serializable",
    );
  });
});
