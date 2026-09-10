#!/usr/bin/env node
// Applies the versioned Hicks Orchestrator tool profile to an external config.
// Config/state stay outside the runtime bundle; this owner keeps the change
// backed up and atomic so deployment can recover without hand-edited JSON.
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const REQUIRED_AGENT = "hicks-orchestrator";

async function regularFile(filePath, label) {
  const stats = await fs.lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  return stats;
}

async function readJson(filePath, label) {
  await regularFile(filePath, label);
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${filePath}`, { cause: error });
  }
}

function validatePolicy(policy) {
  if (policy?.schema !== 1 || policy?.agentId !== REQUIRED_AGENT) {
    throw new Error("Hicks Orchestrator policy has an unsupported schema or agent id");
  }
  if (
    policy.profile !== "full" ||
    !Array.isArray(policy.alsoAllow) ||
    !Array.isArray(policy.deny)
  ) {
    throw new Error(
      "Hicks Orchestrator policy must define profile=full, alsoAllow, and deny arrays",
    );
  }
  const required = [
    "workboard_create",
    "workboard_claim",
    "workboard_decompose",
    "workboard_dispatch",
  ];
  if (required.some((name) => !policy.alsoAllow.includes(name))) {
    throw new Error("Hicks Orchestrator policy is missing required Workboard tools");
  }
  if (!policy.deny.includes("hicks_delegate")) {
    throw new Error("Hicks Orchestrator policy must deny the Front-only hicks_delegate tool");
  }
  if (policy.contract?.telegramBinding !== false || policy.contract?.maxSpawnDepth !== 2) {
    throw new Error("Hicks Orchestrator policy violates the no-Telegram/maxSpawnDepth contract");
  }
}

export async function applyOrchestratorToolPolicy({ configPath, policyPath, backupPath }) {
  if (!configPath || !policyPath || !backupPath) {
    throw new Error("configPath, policyPath, and backupPath are required");
  }
  const configStats = await regularFile(configPath, "OpenClaw config");
  const policy = await readJson(policyPath, "Hicks Orchestrator policy");
  validatePolicy(policy);
  const config = await readJson(configPath, "OpenClaw config");
  const agent = config?.agents?.entries?.[REQUIRED_AGENT];
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    throw new Error(`OpenClaw config has no ${REQUIRED_AGENT} agent entry`);
  }
  const hasTelegramBinding =
    Array.isArray(config.bindings) &&
    config.bindings.some((binding) => binding?.agentId === REQUIRED_AGENT);
  if (agent.bindings !== undefined || hasTelegramBinding) {
    throw new Error("Hicks Orchestrator must not have a Telegram binding");
  }
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.copyFile(configPath, backupPath);
  await fs.chmod(backupPath, configStats.mode & 0o777);
  const next = structuredClone(config);
  const previousTools = next.agents.entries[REQUIRED_AGENT].tools;
  next.agents.entries[REQUIRED_AGENT].tools = {
    ...(previousTools && typeof previousTools === "object" ? previousTools : {}),
    profile: policy.profile,
    alsoAllow: [...policy.alsoAllow],
    deny: [
      ...new Set([
        ...(Array.isArray(previousTools?.deny) ? previousTools.deny : []),
        ...policy.deny,
      ]),
    ],
  };
  delete next.agents.entries[REQUIRED_AGENT].tools.allow;
  const dir = path.dirname(configPath);
  const tempPath = path.join(
    dir,
    `.${path.basename(configPath)}.hicks-policy-${process.pid}-${Date.now()}`,
  );
  try {
    const handle = await fs.open(tempPath, "wx", configStats.mode & 0o777);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.chown(tempPath, configStats.uid, configStats.gid);
    await fs.rename(tempPath, configPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
  return {
    configPath,
    backupPath,
    agentId: REQUIRED_AGENT,
    profile: policy.profile,
    alsoAllowCount: policy.alsoAllow.length,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      options.configPath = argv[++index];
    } else if (arg === "--policy") {
      options.policyPath = argv[++index];
    } else if (arg === "--backup") {
      options.backupPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      return null;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options) {
      console.error(
        "Usage: node scripts/hicks-orchestrator-policy-sync.mjs --config PATH --policy PATH --backup PATH",
      );
      process.exit(0);
    }
    const result = await applyOrchestratorToolPolicy(options);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      `[hicks-orchestrator-policy-sync] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
