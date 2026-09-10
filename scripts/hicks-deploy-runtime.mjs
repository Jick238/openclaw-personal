#!/usr/bin/env node
// Transactional owner for a self-hosted runtime install. The state/config
// directory is deliberately outside the cutover root and is never copied.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { assertCodexReleasePackageContract } from "./e2e/lib/codex-release-package-assertions.mjs";

export const CODEX_SMOKE_MARKER = "HICKS_DEPLOY_SMOKE_OK";
const HICKS_REFERENCE_FILES = [
  ["OWNER_POLICY.md", "customization/hicks/OWNER_POLICY.md"],
  [
    "HICKS_ORCHESTRATOR_TOOL_POLICY.json",
    "customization/hicks/HICKS_ORCHESTRATOR_TOOL_POLICY.json",
  ],
  ["HICKS_ARCHITECTURE_PLAN.md", "HICKS_ARCHITECTURE_PLAN.md"],
  ["WORKLOG.md", "WORKLOG.md"],
];
const CODEX_PLATFORM_ALIASES = new Map([
  ["linux:x64", "@openai/codex-linux-x64"],
  ["linux:arm64", "@openai/codex-linux-arm64"],
  ["darwin:x64", "@openai/codex-darwin-x64"],
  ["darwin:arm64", "@openai/codex-darwin-arm64"],
  ["win32:x64", "@openai/codex-win32-x64"],
  ["win32:arm64", "@openai/codex-win32-arm64"],
]);
const LEGACY_INSTALL_ARTIFACT_PREFIXES = [
  "dist.pre-",
  "dist.backup-",
  "dist.failed-",
  ".openclaw.stage-",
  ".openclaw.backup-",
  ".openclaw.failed-",
];

function isLegacyInstallArtifact(name) {
  return LEGACY_INSTALL_ARTIFACT_PREFIXES.some((prefix) => name.startsWith(prefix));
}

const exists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

async function canonicalPath(filePath) {
  let current = path.resolve(filePath);
  const suffix = [];
  while (true) {
    try {
      const resolved = await fs.realpath(current);
      return path.join(resolved, ...suffix.toReversed());
    } catch (error) {
      if (error?.code !== "ENOENT" || current === path.dirname(current)) {
        throw error;
      }
      suffix.push(path.basename(current));
      current = path.dirname(current);
    }
  }
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function dependencyPath(root, packageName) {
  return path.join(root, "node_modules", ...packageName.split("/"));
}

function commandResult(command, args, result) {
  return {
    command,
    args,
    status: result.status ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const limit = options.maxOutputBytes ?? 1024 * 1024;
    child.stdout.on("data", (chunk) => {
      if (stdout.length < limit) {
        stdout += chunk.toString("utf8").slice(0, limit - stdout.length);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < limit) {
        stderr += chunk.toString("utf8").slice(0, limit - stderr.length);
      }
    });
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs)
      : undefined;
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve(
        commandResult(command, args, {
          status: status ?? 1,
          stdout,
          stderr: signal ? `${stderr}\n${signal}` : stderr,
        }),
      );
    });
  });
}

async function checked(execute, command, args, options, label) {
  const result = await execute(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (exit ${String(result.status)}): ${result.stderr || result.stdout || "no output"}`,
    );
  }
  return result;
}

async function startAndVerifyService(execute, serviceName, options, label) {
  await checked(execute, "systemctl", ["start", serviceName], options, label);
  await checked(
    execute,
    "systemctl",
    ["is-active", "--quiet", serviceName],
    options,
    `${label} readiness`,
  );
}

async function copyEntry(source, destination) {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, { recursive: true, force: true, errorOnExist: false });
}

async function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  digest.update(await fs.readFile(filePath));
  return digest.digest("hex");
}

async function assertDirectory(dirPath, label) {
  let stats;
  try {
    stats = await fs.lstat(dirPath);
  } catch (error) {
    throw new Error(`${label} is missing: ${dirPath}`, { cause: error });
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${dirPath}`);
  }
}

function customizationPaths(
  workspaceRoot,
  stamp = new Date().toISOString().replace(/[^0-9]/g, ""),
) {
  const managedRoot = path.join(workspaceRoot, "hicks-reference");
  return {
    managedRoot,
    stageRoot: path.join(workspaceRoot, `.hicks-reference.stage-${stamp}-${crypto.randomUUID()}`),
    backupRoot: path.join(workspaceRoot, `.hicks-reference.backup-${stamp}`),
    failedRoot: path.join(workspaceRoot, `.hicks-reference.failed-${stamp}`),
  };
}

async function stageCustomization({ sourceRoot, workspaceRoot, stamp }) {
  await assertDirectory(workspaceRoot, "Hicks workspace root");
  const paths = customizationPaths(workspaceRoot, stamp);
  for (const destination of [paths.managedRoot, paths.backupRoot, paths.failedRoot]) {
    if (await exists(destination)) {
      const stats = await fs.lstat(destination);
      if (stats.isSymbolicLink()) {
        throw new Error(`Hicks customization destination must not be a symlink: ${destination}`);
      }
      if (destination !== paths.managedRoot) {
        throw new Error(
          `rollback destination already exists for customization stamp: ${destination}`,
        );
      }
    }
  }
  await fs.mkdir(paths.stageRoot);
  const files = {};
  try {
    for (const [name, relativeSource] of HICKS_REFERENCE_FILES) {
      const source = path.join(sourceRoot, relativeSource);
      if (!(await exists(source))) {
        throw new Error(`Hicks customization source is missing: ${relativeSource}`);
      }
      const stats = await fs.lstat(source);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`Hicks customization source must be a regular file: ${relativeSource}`);
      }
      const destination = path.join(paths.stageRoot, name);
      await fs.copyFile(source, destination);
      files[name] = {
        source: relativeSource,
        sha256: await sha256File(destination),
        bytes: stats.size,
      };
    }
    await fs.writeFile(
      path.join(paths.stageRoot, ".manifest.json"),
      `${JSON.stringify({ schema: 1, files }, null, 2)}\n`,
    );
  } catch (error) {
    await fs.rm(paths.stageRoot, { recursive: true, force: true });
    throw error;
  }
  return paths;
}

async function copyDependency(sourceRoot, fallbackRoot, stageRoot, packageName) {
  const source = dependencyPath(sourceRoot, packageName);
  const fallback = dependencyPath(fallbackRoot, packageName);
  const selected = (await exists(source)) ? source : (await exists(fallback)) ? fallback : null;
  if (!selected) {
    throw new Error(
      `managed Codex package is absent from source and installed runtime: ${packageName}`,
    );
  }
  await copyEntry(selected, dependencyPath(stageRoot, packageName));
}

async function listLegacyInstallArtifacts(installRoot) {
  const entries = await fs.readdir(installRoot, { withFileTypes: true });
  return entries.filter((entry) => isLegacyInstallArtifact(entry.name));
}

async function moveLegacyInstallArtifacts({ installRoot, stateDir, stamp }) {
  const entries = await listLegacyInstallArtifacts(installRoot);
  if (entries.length === 0) {
    return null;
  }
  if (!stateDir) {
    throw new Error("legacy install artifacts require stateDir for reversible archiving");
  }
  const archiveRoot = path.join(stateDir, "hicks-install-legacy-backups", stamp);
  if (await exists(archiveRoot)) {
    throw new Error(`legacy install archive already exists: ${archiveRoot}`);
  }
  await fs.mkdir(archiveRoot, { recursive: true });
  try {
    await fs.writeFile(
      path.join(archiveRoot, ".manifest.json"),
      `${JSON.stringify(
        { schema: 1, source: "canonical-install", entries: entries.map((entry) => entry.name) },
        null,
        2,
      )}\n`,
    );
    for (const entry of entries) {
      await fs.rename(path.join(installRoot, entry.name), path.join(archiveRoot, entry.name));
    }
  } catch (error) {
    const restoreErrors = [];
    for (const entry of entries) {
      const archived = path.join(archiveRoot, entry.name);
      if (await exists(archived)) {
        try {
          await fs.rename(archived, path.join(installRoot, entry.name));
        } catch (restoreError) {
          restoreErrors.push(restoreError);
        }
      }
    }
    if (restoreErrors.length > 0) {
      const failure = new Error(
        `legacy install archive move failed; recovery data preserved at ${archiveRoot}`,
        { cause: error },
      );
      failure.legacyArchive = { archiveRoot, entries: entries.map((entry) => entry.name) };
      throw failure;
    }
    await fs.rm(archiveRoot, { recursive: true, force: true });
    throw error;
  }
  return { archiveRoot, entries: entries.map((entry) => entry.name) };
}

async function restoreLegacyInstallArtifacts(installRoot, archive) {
  if (!archive) {
    return;
  }
  const manifest = await readJson(path.join(archive.archiveRoot, ".manifest.json"));
  for (const name of manifest.entries) {
    const archived = path.join(archive.archiveRoot, name);
    if (await exists(archived)) {
      await fs.rename(archived, path.join(installRoot, name));
    }
  }
  await fs.rm(archive.archiveRoot, { recursive: true, force: true });
}

async function stageRuntime({ sourceRoot, installRoot, stageRoot, platform, arch }) {
  if (!(await exists(path.join(sourceRoot, "dist")))) {
    throw new Error(`source dist is missing: ${sourceRoot}`);
  }
  if (!(await exists(installRoot))) {
    throw new Error(`installed runtime is missing: ${installRoot}`);
  }
  if (path.resolve(sourceRoot) === path.resolve(installRoot)) {
    throw new Error("source and install roots must differ");
  }

  await fs.cp(installRoot, stageRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (source) =>
      path.dirname(source) !== installRoot || !isLegacyInstallArtifact(path.basename(source)),
  });
  for (const entry of ["dist", "package.json", "openclaw.mjs"]) {
    const source = path.join(sourceRoot, entry);
    if (await exists(source)) {
      await copyEntry(source, path.join(stageRoot, entry));
    }
  }

  const alias = CODEX_PLATFORM_ALIASES.get(`${platform}:${arch}`);
  if (!alias) {
    throw new Error(`unsupported Codex deployment platform: ${platform}/${arch}`);
  }
  await copyDependency(sourceRoot, installRoot, stageRoot, "@openai/codex");
  await copyDependency(sourceRoot, installRoot, stageRoot, alias);

  const sourcePackage = await readJson(path.join(sourceRoot, "package.json"));
  await fs.writeFile(
    path.join(stageRoot, ".openclaw-deploy-manifest.json"),
    `${JSON.stringify(
      {
        schema: 1,
        packageVersion: sourcePackage.version ?? null,
        codexPlatform: alias,
        codexPackage: "@openai/codex",
      },
      null,
      2,
    )}\n`,
  );
}

async function validateStage({ stageRoot, platform, arch, execute, env, timeoutMs }) {
  const pluginPackageJson = path.join(stageRoot, "dist", "extensions", "codex", "package.json");
  const codexPackageJson = path.join(stageRoot, "node_modules", "@openai", "codex", "package.json");
  const contract = assertCodexReleasePackageContract({
    platform,
    arch,
    pluginPackageJson,
    codexPackageJson,
    managedRoot: stageRoot,
    packageRoots: [stageRoot],
    recordEvidence: false,
  });

  const entry = (await exists(path.join(stageRoot, "openclaw.mjs")))
    ? path.join(stageRoot, "openclaw.mjs")
    : path.join(stageRoot, "dist", "entry.js");
  const doctor = await checked(
    execute,
    process.execPath,
    [entry, "doctor", "--lint", "--only", "codex/managed-app-server", "--json"],
    { env, timeoutMs },
    "Codex doctor preflight",
  );
  let report;
  try {
    report = JSON.parse(doctor.stdout.trim());
  } catch (error) {
    throw new Error(`Codex doctor preflight did not return JSON`, { cause: error });
  }
  if (report.ok !== true || !Array.isArray(report.findings) || report.findings.length !== 0) {
    throw new Error(`Codex doctor preflight reported findings: ${JSON.stringify(report)}`);
  }
  return {
    entry,
    entryRelative: path.relative(stageRoot, entry),
    codexBin: contract.codexBin,
    evidence: contract.evidence,
  };
}

function deploymentPaths(installRoot, stamp = new Date().toISOString().replace(/[^0-9]/g, "")) {
  const parent = path.dirname(installRoot);
  const base = path.basename(installRoot);
  return {
    stageRoot: path.join(parent, `.${base}.stage-${stamp}-${crypto.randomUUID()}`),
    backupRoot: path.join(parent, `.${base}.backup-${stamp}`),
    failedRoot: path.join(parent, `.${base}.failed-${stamp}`),
  };
}

async function renameIfPresent(from, to) {
  if (await exists(from)) {
    await fs.rename(from, to);
  }
}

function smokeArgs(entry, sessionKey) {
  return [
    entry,
    "agent",
    "--agent",
    "main",
    "--session-key",
    sessionKey,
    "--message",
    `Reply with exact ASCII text ${CODEX_SMOKE_MARKER} only.`,
    "--thinking",
    "off",
    "--timeout",
    "60",
    "--json",
  ];
}

export async function deployRuntime(options, dependencies = {}) {
  if (!options.workspaceRoot) {
    throw new Error("Hicks workspace root is required for owner-policy/reference deployment");
  }
  const sourceRoot = path.resolve(options.sourceRoot ?? process.cwd());
  const installRoot = path.resolve(options.installRoot);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const execute = dependencies.execute ?? runCommand;
  const paths = deploymentPaths(installRoot, options.stamp);
  const installStats = await fs.lstat(installRoot);
  if (!installStats.isDirectory() || installStats.isSymbolicLink()) {
    throw new Error("runtime install root must be a real directory");
  }
  const env = { ...process.env, ...options.env };
  if (options.stateDir) {
    env.OPENCLAW_STATE_DIR = options.stateDir;
  }
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const stateDirInput = options.stateDir ?? env.OPENCLAW_STATE_DIR;
  const installCanonical = await canonicalPath(installRoot);
  const workspaceCanonical = await canonicalPath(workspaceRoot);
  const stateCanonical = stateDirInput ? await canonicalPath(stateDirInput) : undefined;
  if (isPathInside(installCanonical, workspaceCanonical)) {
    throw new Error("Hicks workspace root must remain outside the runtime install root");
  }
  if (stateCanonical && isPathInside(installCanonical, stateCanonical)) {
    throw new Error("OPENCLAW_STATE_DIR must remain outside the runtime install root");
  }
  if ((await exists(paths.backupRoot)) || (await exists(paths.failedRoot))) {
    throw new Error(
      `rollback destination already exists for deployment stamp: ${options.stamp ?? "current"}`,
    );
  }

  const stateDir = stateCanonical;
  const customization = await stageCustomization({
    sourceRoot,
    workspaceRoot,
    stamp: options.stamp,
  });
  let validation;
  try {
    await stageRuntime({ sourceRoot, installRoot, stageRoot: paths.stageRoot, platform, arch });
    validation = await validateStage({
      stageRoot: paths.stageRoot,
      platform,
      arch,
      execute,
      env,
      timeoutMs,
    });
    if (options.dryRun) {
      await fs.rm(paths.stageRoot, { recursive: true, force: true });
      await fs.rm(customization.stageRoot, { recursive: true, force: true });
      return { dryRun: true, ...paths, customization, validation, legacyArchive: null };
    }

    let cutoverStarted = false;
    let customizationCutoverStarted = false;
    let legacyArchive;
    let serviceStopped = false;
    try {
      await checked(
        execute,
        "systemctl",
        ["stop", options.serviceName ?? "openclaw-gateway.service"],
        { env, timeoutMs },
        "Gateway stop",
      );
      serviceStopped = true;
      await fs.rename(installRoot, paths.backupRoot);
      cutoverStarted = true;
      legacyArchive = await moveLegacyInstallArtifacts({
        installRoot: paths.backupRoot,
        stateDir,
        stamp: options.stamp ?? Date.now().toString(),
      });
      await fs.rename(paths.stageRoot, installRoot);
      if (await exists(customization.managedRoot)) {
        await fs.rename(customization.managedRoot, customization.backupRoot);
        customizationCutoverStarted = true;
      }
      await fs.rename(customization.stageRoot, customization.managedRoot);
      customizationCutoverStarted = true;
      await startAndVerifyService(
        execute,
        options.serviceName ?? "openclaw-gateway.service",
        { env, timeoutMs },
        "Gateway start",
      );
      const smoke = await checked(
        execute,
        process.execPath,
        smokeArgs(
          path.join(installRoot, validation.entryRelative),
          options.sessionKey ?? `hicks-deploy-${Date.now()}`,
        ),
        { env, timeoutMs },
        "bounded Gateway agent smoke",
      );
      if (!smoke.stdout.includes(CODEX_SMOKE_MARKER)) {
        throw new Error(`bounded Gateway agent smoke omitted ${CODEX_SMOKE_MARKER}`);
      }
      return { dryRun: false, ...paths, customization, validation, legacyArchive };
    } catch (error) {
      if (error?.legacyArchive) {
        legacyArchive = error.legacyArchive;
      }
      if (!cutoverStarted) {
        let restartError;
        if (serviceStopped) {
          try {
            await startAndVerifyService(
              execute,
              options.serviceName ?? "openclaw-gateway.service",
              { env, timeoutMs },
              "Gateway restart before cutover rollback",
            );
          } catch (failure) {
            restartError = failure;
          }
        }
        if (restartError) {
          const failure = new Error(
            "deployment failed before cutover and old Gateway restart/readiness failed",
            { cause: error },
          );
          failure.restartError = restartError;
          throw failure;
        }
        throw new Error("deployment failed before cutover; old Gateway restarted", {
          cause: error,
        });
      }
      let rollbackError;
      try {
        await execute("systemctl", ["stop", options.serviceName ?? "openclaw-gateway.service"], {
          env,
          timeoutMs,
        });
        if (customizationCutoverStarted) {
          await renameIfPresent(customization.managedRoot, customization.failedRoot);
          await renameIfPresent(customization.backupRoot, customization.managedRoot);
        }
        if (await exists(paths.backupRoot)) {
          await renameIfPresent(installRoot, paths.failedRoot);
          await restoreLegacyInstallArtifacts(paths.backupRoot, legacyArchive);
          await fs.rename(paths.backupRoot, installRoot);
        }
        await startAndVerifyService(
          execute,
          options.serviceName ?? "openclaw-gateway.service",
          { env, timeoutMs },
          "Gateway restart after rollback",
        );
      } catch (rollbackFailure) {
        rollbackError = rollbackFailure;
      }
      if (rollbackError) {
        const recoveryPath = [error, rollbackError]
          .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
          .map((message) => message.match(/recovery data preserved at (.+)$/)?.[1])
          .find(Boolean);
        const failure = new Error(
          `deployment failed and automatic full-bundle rollback failed${recoveryPath ? `; recovery data preserved at ${recoveryPath}` : ""}`,
          { cause: error },
        );
        failure.rollbackError = rollbackError;
        throw failure;
      }
      throw new Error(
        `deployment failed and full bundle was rolled back: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  } finally {
    if (await exists(paths.stageRoot)) {
      await fs.rm(paths.stageRoot, { recursive: true, force: true });
    }
    if (await exists(customization.stageRoot)) {
      await fs.rm(customization.stageRoot, { recursive: true, force: true });
    }
  }
}

function usage() {
  console.error(
    "Usage: node scripts/hicks-deploy-runtime.mjs --install-root PATH --workspace-root PATH [--source-root PATH] [--dry-run]",
  );
}

function parseArgs(argv) {
  const parsed = { sourceRoot: process.cwd(), dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--source-root") {
      parsed.sourceRoot = argv[++i];
    } else if (arg === "--install-root") {
      parsed.installRoot = argv[++i];
    } else if (arg === "--workspace-root") {
      parsed.workspaceRoot = argv[++i];
    } else if (arg === "--service") {
      parsed.serviceName = argv[++i];
    } else if (arg === "--state-dir") {
      parsed.stateDir = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      return null;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options) {
      usage();
      process.exit(0);
    }
    if (!options.installRoot || !options.workspaceRoot) {
      usage();
      process.exit(2);
    }
    const result = await deployRuntime(options);
    console.log(
      JSON.stringify({
        dryRun: result.dryRun,
        backupRoot: result.backupRoot,
        customization: result.customization
          ? {
              managedRoot: result.customization.managedRoot,
              backupRoot: result.customization.backupRoot,
            }
          : undefined,
        codex: result.validation.evidence,
      }),
    );
  } catch (error) {
    console.error(
      `[hicks-deploy-runtime] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
