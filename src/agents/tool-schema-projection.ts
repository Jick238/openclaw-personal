import type { AnyAgentTool } from "./tools/common.js";

export type RuntimeToolInputSchemaJson =
  | null
  | boolean
  | number
  | string
  | RuntimeToolInputSchemaJson[]
  | { [key: string]: RuntimeToolInputSchemaJson };

export type RuntimeToolInputSchemaProjection = {
  readonly schema: RuntimeToolInputSchemaJson;
  readonly violations: readonly string[];
};

export type RuntimeToolSchemaDiagnostic = {
  readonly toolName: string;
  readonly toolIndex: number;
  readonly violations: readonly string[];
};

export type RuntimeToolSchemaInspection<TTool extends Pick<AnyAgentTool, "name" | "parameters">> = {
  readonly tools: readonly TTool[];
  readonly diagnostics: readonly RuntimeToolSchemaDiagnostic[];
};

type ToolSchemaInspectionMode = "runtime" | "provider-normalizable";

function isJsonValue(value: unknown): value is RuntimeToolInputSchemaJson {
  if (value === null) {
    return true;
  }
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return true;
    case "object":
      if (Array.isArray(value)) {
        return value.every(isJsonValue);
      }
      return Object.values(value).every(isJsonValue);
    default:
      return false;
  }
}

function isJsonObject(value: RuntimeToolInputSchemaJson): value is {
  [key: string]: RuntimeToolInputSchemaJson;
} {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializeToolInputSchema(value: unknown, path: string): RuntimeToolInputSchemaProjection {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return {
      schema: {},
      violations: [`${path} is not JSON-serializable`],
    };
  }
  if (!text) {
    return {
      schema: {},
      violations: [`${path} is not JSON-serializable`],
    };
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isJsonValue(parsed)) {
    return {
      schema: {},
      violations: [`${path} is not a JSON value`],
    };
  }
  return {
    schema: parsed,
    violations: [],
  };
}

function findDynamicSchemaKeywordViolations(
  schema: RuntimeToolInputSchemaJson,
  path: string,
): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((entry, index) =>
      findDynamicSchemaKeywordViolations(entry, `${path}[${index}]`),
    );
  }
  if (!isJsonObject(schema)) {
    return [];
  }
  const violations: string[] = [];
  for (const key of ["$dynamicRef", "$dynamicAnchor"] as const) {
    if (key in schema) {
      violations.push(`${path}.${key}`);
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    if (schemaMapKeywords.has(key) && isJsonObject(value)) {
      for (const [schemaName, childSchema] of Object.entries(value)) {
        violations.push(
          ...findDynamicSchemaKeywordViolations(childSchema, `${path}.${key}.${schemaName}`),
        );
      }
    } else {
      violations.push(...findDynamicSchemaKeywordViolations(value, `${path}.${key}`));
    }
  }
  return violations;
}

const schemaMapKeywords = new Set([
  "$defs",
  "definitions",
  "dependencies",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

export function projectRuntimeToolInputSchema(
  schema: unknown,
  path = "parameters",
): RuntimeToolInputSchemaProjection {
  const projection = serializeToolInputSchema(schema, path);
  const violations = [...projection.violations];
  if (!isJsonObject(projection.schema)) {
    violations.push(`${path} must be a JSON object schema`);
  } else if (projection.schema.type !== undefined && projection.schema.type !== "object") {
    violations.push(`${path}.type must be "object"`);
  }
  violations.push(...findDynamicSchemaKeywordViolations(projection.schema, path));
  return {
    schema: projection.schema,
    violations,
  };
}

function inspectToolSchema(
  tool: Pick<AnyAgentTool, "name" | "parameters">,
  toolIndex: number,
  mode: ToolSchemaInspectionMode,
): RuntimeToolSchemaDiagnostic | undefined {
  const toolName = tool.name || `tool[${toolIndex}]`;
  const schemaPath = `${toolName}.parameters`;
  const projectionViolations =
    mode === "runtime"
      ? projectRuntimeToolInputSchema(tool.parameters, schemaPath).violations
      : tool.parameters !== null && typeof tool.parameters === "object"
        ? projectRuntimeToolInputSchema(tool.parameters, schemaPath).violations.filter(
            (violation) =>
              violation === `${schemaPath} is not JSON-serializable` ||
              violation === `${schemaPath} is not a JSON value`,
          )
        : [];
  return projectionViolations.length > 0
    ? { toolName, toolIndex, violations: projectionViolations }
    : undefined;
}

function inspectToolSchemas<TTool extends Pick<AnyAgentTool, "name" | "parameters">>(
  tools: readonly TTool[],
  mode: ToolSchemaInspectionMode,
): RuntimeToolSchemaInspection<TTool> {
  const diagnostics: RuntimeToolSchemaDiagnostic[] = [];
  const compatibleTools: TTool[] = [];
  for (const [toolIndex, tool] of tools.entries()) {
    const diagnostic = inspectToolSchema(tool, toolIndex, mode);
    if (diagnostic) {
      diagnostics.push(diagnostic);
      continue;
    }
    compatibleTools.push(tool);
  }
  return { tools: compatibleTools, diagnostics };
}

export function inspectRuntimeToolInputSchemas(
  tools: readonly Pick<AnyAgentTool, "name" | "parameters">[],
): RuntimeToolSchemaDiagnostic[] {
  return [...inspectToolSchemas(tools, "runtime").diagnostics];
}

export function filterRuntimeCompatibleTools<
  TTool extends Pick<AnyAgentTool, "name" | "parameters">,
>(tools: readonly TTool[]): RuntimeToolSchemaInspection<TTool> {
  return inspectToolSchemas(tools, "runtime");
}

export function filterProviderNormalizableTools<
  TTool extends Pick<AnyAgentTool, "name" | "parameters">,
>(tools: readonly TTool[]): RuntimeToolSchemaInspection<TTool> {
  return inspectToolSchemas(tools, "provider-normalizable");
}
