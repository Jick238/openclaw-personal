import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  filterProviderNormalizableTools,
  type RuntimeToolSchemaDiagnostic,
} from "./tool-schema-projection.js";
import type { AnyAgentTool } from "./tools/common.js";

const log = createSubsystemLogger("agents/tools");

export function logRuntimeToolSchemaQuarantine(params: {
  diagnostics: readonly RuntimeToolSchemaDiagnostic[];
  tools: readonly AnyAgentTool[];
  runId: string;
  sessionKey?: string;
  sessionId?: string;
}): void {
  if (params.diagnostics.length === 0) {
    return;
  }
  const summary = params.diagnostics
    .map((diagnostic) => {
      const tool = params.tools[diagnostic.toolIndex];
      const pluginId = tool ? getPluginToolMeta(tool)?.pluginId : undefined;
      const owner = pluginId ? ` plugin=${pluginId}` : "";
      emitTrustedDiagnosticEvent({
        type: "tool.execution.blocked",
        runId: params.runId,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        toolName: diagnostic.toolName,
        toolSource: pluginId ? "plugin" : "core",
        ...(pluginId ? { toolOwner: pluginId } : {}),
        deniedReason: "unsupported_tool_schema",
        reason: diagnostic.violations.join(", "),
      });
      return `${diagnostic.toolName}${owner}: ${diagnostic.violations.join(", ")}`;
    })
    .join("; ");
  log.warn(
    `[tools] quarantined ${params.diagnostics.length} unsupported tool schema${params.diagnostics.length === 1 ? "" : "s"} before model runtime projection: ${summary}. Run openclaw doctor for details.`,
  );
}

export function filterProviderNormalizableRuntimeTools(params: {
  tools: readonly AnyAgentTool[];
  runId: string;
  sessionKey?: string;
  sessionId?: string;
}): AnyAgentTool[] {
  const projection = filterProviderNormalizableTools(params.tools);
  logRuntimeToolSchemaQuarantine({
    diagnostics: projection.diagnostics,
    tools: params.tools,
    runId: params.runId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  });
  return [...projection.tools];
}
