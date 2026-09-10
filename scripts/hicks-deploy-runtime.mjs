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
export const HICKS_ACCEPTANCE_SCHEMA = 2;
export const HICKS_ACCEPTANCE_MAX_AGE_MS = 15 * 60 * 1_000;
export const HICKS_ACCEPTANCE_CONTOURS = Object.freeze([
  "guest",
  "delegation-parallel",
  "no-fake-progress",
]);
const HICKS_ACCEPTANCE_SPECS = Object.freeze({
  guest: Object.freeze({
    testFiles: ["extensions/telegram/src/bot-handlers.guest.test.ts"],
    artifactFiles: [
      "extensions/telegram/src/bot-handlers.guest.ts",
      "extensions/telegram/src/bot-handlers.guest.test.ts",
    ],
  }),
  "delegation-parallel": Object.freeze({
    testFiles: [
      "extensions/workboard/src/front-admission.test.ts",
      "extensions/workboard/src/dispatcher.test.ts",
    ],
    artifactFiles: [
      "extensions/workboard/src/front-admission.ts",
      "extensions/workboard/src/dispatcher.ts",
      "extensions/workboard/src/front-admission.test.ts",
      "extensions/workboard/src/dispatcher.test.ts",
    ],
  }),
  "no-fake-progress": Object.freeze({
    testFiles: [
      "extensions/workboard/src/dispatcher-ownership.test.ts",
      "extensions/workboard/src/lifecycle-sync.test.ts",
      "extensions/workboard/src/lifecycle-sync.restart.test.ts",
    ],
    artifactFiles: [
      "extensions/workboard/src/dispatcher.ts",
      "extensions/workboard/src/lifecycle-sync.ts",
      "extensions/workboard/src/dispatcher-ownership.test.ts",
      "extensions/workboard/src/lifecycle-sync.test.ts",
      "extensions/workboard/src/lifecycle-sync.restart.test.ts",
    ],
  }),
});
const HICKS_BUILD_METADATA_FILES = [
  "dist/build-info.json",
  "dist/.buildstamp",
  "dist/.runtime-postbuildstamp",
  "dist/telegram-ingress-worker.runtime.js",
];
const HICKS_BUILD_COMMITS = [
  ["dist/build-info.json", "commit", "buildInfoCommit"],
  ["dist/.buildstamp", "head", "distBuildstampCommit"],
  ["dist/.runtime-postbuildstamp", "head", "runtimePostbuildstampCommit"],
];
const FULL_COMMIT_RE = /^[a-f0-9]{40}$/u;
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

async function resolveRepoCommit(execute, sourceRoot, env, timeoutMs) {
  const result = await checked(
    execute,
    "git",
    ["-C", sourceRoot, "rev-parse", "HEAD"],
    { env, timeoutMs },
    "Hicks repository identity",
  );
  return stampedCommit(result.stdout.trim(), "repository");
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

async function buildArtifactPaths(root) {
  const distRoot = path.join(root, "dist");
  const entries = await fs.readdir(distRoot, { withFileTypes: true });
  const telegramBundles = entries
    .filter(
      (entry) => entry.isFile() && /^telegram-ingress-drain-factory-.+\.js$/u.test(entry.name),
    )
    .map((entry) => path.join("dist", entry.name));
  if (telegramBundles.length !== 1) {
    throw new Error(
      `Hicks build identity requires exactly one Telegram ingress bundle, found ${telegramBundles.length}`,
    );
  }
  return [...HICKS_BUILD_METADATA_FILES, ...telegramBundles];
}

function stampedCommit(value, label) {
  if (!FULL_COMMIT_RE.test(value ?? "")) {
    throw new Error(`${label} does not contain a full Git commit SHA`);
  }
  return value;
}

async function readBuildIdentity(root, repoCommit) {
  const artifacts = await acceptanceArtifacts(root, await buildArtifactPaths(root));
  const stamped = Object.fromEntries(
    await Promise.all(
      HICKS_BUILD_COMMITS.map(async ([file, field, key]) => {
        const commit = stampedCommit((await readJson(path.join(root, file)))[field], file);
        if (commit !== repoCommit) {
          throw new Error(`Hicks build identity mismatch: ${file}=${commit} repo=${repoCommit}`);
        }
        return [key, commit];
      }),
    ),
  );
  return { repoCommit, ...stamped, artifacts };
}

function sameBuildIdentity(expected, actual) {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

async function acceptanceArtifacts(sourceRoot, relativePaths) {
  const artifacts = [];
  for (const relativePath of relativePaths) {
    const filePath = path.join(sourceRoot, relativePath);
    let stats;
    try {
      stats = await fs.lstat(filePath);
    } catch (error) {
      throw new Error(`Hicks acceptance artifact is missing: ${relativePath}`, { cause: error });
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0) {
      throw new Error(
        `Hicks acceptance artifact must be a non-empty regular file: ${relativePath}`,
      );
    }
    artifacts.push({
      path: relativePath,
      bytes: stats.size,
      sha256: await sha256File(filePath),
    });
  }
  return artifacts;
}

function validateTimestamp(timestampMs, label) {
  if (!Number.isSafeInteger(timestampMs)) {
    throw new Error(`${label} has no valid generation timestamp`);
  }
}

function validateFreshTimestamp(timestampMs, nowMs, label) {
  validateTimestamp(timestampMs, label);
  const ageMs = nowMs - timestampMs;
  if (ageMs < 0 || ageMs > HICKS_ACCEPTANCE_MAX_AGE_MS) {
    throw new Error(`${label} is stale or from the future: ageMs=${ageMs}`);
  }
}

function sameSorted(values, expected) {
  return JSON.stringify([...values].toSorted()) === JSON.stringify([...expected].toSorted());
}

function requireAcceptance(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function exactContourMap(value, label) {
  const expected = [...HICKS_ACCEPTANCE_CONTOURS].toSorted();
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !sameSorted(Object.keys(value), expected)
  ) {
    throw new Error(`${label} contours mismatch: expected ${expected.join(",")}`);
  }
  return value;
}

function validateSourceContour(contour, evidence, spec) {
  const artifactProof =
    Array.isArray(evidence?.artifacts) &&
    sameSorted(
      evidence.artifacts.map((artifact) => artifact?.path),
      spec.artifactFiles,
    ) &&
    evidence.artifacts.every(
      (artifact) =>
        artifact &&
        typeof artifact.path === "string" &&
        Number.isSafeInteger(artifact.bytes) &&
        artifact.bytes > 0 &&
        typeof artifact.sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(artifact.sha256),
    );
  requireAcceptance(
    evidence?.status === "passed" &&
      Array.isArray(evidence.testFiles) &&
      sameSorted(evidence.testFiles, spec.testFiles),
    `Hicks source gate has invalid test evidence: ${contour}`,
  );
  requireAcceptance(artifactProof, `Hicks source gate has invalid artifact proof: ${contour}`);
  requireAcceptance(
    typeof evidence.outputSha256 === "string" && /^[a-f0-9]{64}$/u.test(evidence.outputSha256),
    `Hicks source gate has invalid test output proof: ${contour}`,
  );
}

function validateSourceGates(sourceGates) {
  if (
    !sourceGates ||
    sourceGates.runner !== "scripts/run-vitest.mjs" ||
    sourceGates.networkBoundary !== "none"
  ) {
    throw new Error("Hicks source gates must use the local unit-test runner");
  }
  validateTimestamp(sourceGates.generatedAtMs, "Hicks source gates");
  const contours = exactContourMap(sourceGates.contours, "Hicks source gates");
  for (const contour of HICKS_ACCEPTANCE_CONTOURS) {
    const evidence = contours[contour];
    const spec = HICKS_ACCEPTANCE_SPECS[contour];
    validateSourceContour(contour, evidence, spec);
  }
  return sourceGates;
}

export function validateHicksAcceptanceManifest(manifest) {
  if (!manifest || manifest.schema !== HICKS_ACCEPTANCE_SCHEMA) {
    throw new Error("Hicks acceptance manifest has an unsupported schema");
  }
  if (!manifest.deploymentId || typeof manifest.deploymentId !== "string") {
    throw new Error("Hicks acceptance manifest has no deployment identity");
  }
  if (manifest.networkBoundary !== "none") {
    throw new Error("Hicks acceptance manifest must declare networkBoundary=none");
  }
  validateTimestamp(manifest.deployedAtMs, "Hicks deployment acceptance");
  validateSourceGates(manifest.sourceGates);
  const contours = exactContourMap(manifest.contours, "Hicks live");
  const statuses = new Set(HICKS_ACCEPTANCE_CONTOURS.map((contour) => contours[contour]?.status));
  if (statuses.size !== 1 || !["awaiting-live", "passed"].includes([...statuses][0])) {
    throw new Error("Hicks live contours must be uniformly awaiting-live or passed");
  }
  if (statuses.has("passed")) {
    validateTimestamp(manifest.finalizedAtMs, "Hicks live finalization");
    validateLiveEvidence(manifest.liveEvidence, manifest, undefined);
    if (manifest.finalizedAtMs < manifest.liveEvidence.createdAtMs) {
      throw new Error("Hicks live finalization predates its evidence");
    }
  }
  return manifest;
}

function validateLiveEvidence(evidenceManifest, deploymentAcceptance, nowMs) {
  if (!evidenceManifest || evidenceManifest.schema !== HICKS_ACCEPTANCE_SCHEMA) {
    throw new Error("Hicks live evidence has an unsupported schema");
  }
  if (evidenceManifest.deploymentId !== deploymentAcceptance.deploymentId) {
    throw new Error("Hicks live evidence deployment identity does not match the installed bundle");
  }
  if (nowMs === undefined) {
    validateTimestamp(evidenceManifest.createdAtMs, "Hicks live evidence");
  } else {
    validateFreshTimestamp(evidenceManifest.createdAtMs, nowMs, "Hicks live evidence");
  }
  if (evidenceManifest.createdAtMs < deploymentAcceptance.deployedAtMs) {
    throw new Error("Hicks live evidence predates the installed deployment");
  }
  const contours = exactContourMap(evidenceManifest.contours, "Hicks live evidence");
  for (const contour of HICKS_ACCEPTANCE_CONTOURS) {
    if (contours[contour]?.status !== "passed") {
      throw new Error(`Hicks live evidence is not passed: ${contour}`);
    }
  }
  const guest = contours.guest;
  if (
    (typeof guest.telegramUpdateId !== "string" && typeof guest.telegramUpdateId !== "number") ||
    guest.answerGuestQuery !== true ||
    typeof guest.providerRequestId !== "string" ||
    !guest.providerRequestId
  ) {
    throw new Error("Hicks Guest live evidence is incomplete");
  }
  const delegation = contours["delegation-parallel"];
  if (
    typeof delegation.frontAdmissionId !== "string" ||
    !delegation.frontAdmissionId ||
    !Array.isArray(delegation.workerIds) ||
    delegation.workerIds.length < 2 ||
    delegation.workerIds.some((id) => typeof id !== "string" || !id) ||
    delegation.overlapObserved !== true ||
    delegation.parentReconciled !== true ||
    delegation.finalDeliveryCount !== 1
  ) {
    throw new Error("Hicks parallel delegation live evidence is incomplete");
  }
  const noFakeProgress = contours["no-fake-progress"];
  if (
    noFakeProgress.toolEvidenceOccurred !== true ||
    !Number.isSafeInteger(noFakeProgress.toolEvidenceAtMs) ||
    !Number.isSafeInteger(noFakeProgress.finalAtMs) ||
    noFakeProgress.toolEvidenceAtMs > noFakeProgress.finalAtMs ||
    noFakeProgress.unsupportedSuccess !== false
  ) {
    throw new Error("Hicks no-fake-progress live evidence is incomplete");
  }
}

export function finalizeHicksLiveAcceptance({
  deploymentManifest,
  evidenceManifest,
  nowMs = Date.now(),
}) {
  validateHicksAcceptanceManifest(deploymentManifest?.hicksAcceptance);
  if (
    HICKS_ACCEPTANCE_CONTOURS.some(
      (contour) => deploymentManifest.hicksAcceptance.contours[contour]?.status !== "awaiting-live",
    )
  ) {
    throw new Error("Hicks deployment is not awaiting live acceptance");
  }
  validateLiveEvidence(evidenceManifest, deploymentManifest.hicksAcceptance, nowMs);
  const finalized = structuredClone(deploymentManifest);
  finalized.hicksAcceptance = {
    ...finalized.hicksAcceptance,
    finalizedAtMs: nowMs,
    liveEvidence: structuredClone(evidenceManifest),
    contours: Object.fromEntries(
      HICKS_ACCEPTANCE_CONTOURS.map((contour) => [contour, { status: "passed" }]),
    ),
  };
  return finalized;
}

export async function runHicksAcceptanceSuite({ sourceRoot, execute, env, timeoutMs }) {
  const runner = path.join(sourceRoot, "scripts", "run-vitest.mjs");
  await acceptanceArtifacts(sourceRoot, ["scripts/run-vitest.mjs"]);
  const testFiles = HICKS_ACCEPTANCE_CONTOURS.flatMap(
    (contour) => HICKS_ACCEPTANCE_SPECS[contour].testFiles,
  );
  const result = await checked(
    execute,
    process.execPath,
    [runner, ...testFiles, "--run"],
    { cwd: sourceRoot, env, timeoutMs },
    "Hicks acceptance tests",
  );
  const outputSha256 = crypto.createHash("sha256").update(result.stdout).digest("hex");
  const contours = {};
  for (const contour of HICKS_ACCEPTANCE_CONTOURS) {
    const spec = HICKS_ACCEPTANCE_SPECS[contour];
    const artifacts = await acceptanceArtifacts(sourceRoot, spec.artifactFiles);
    contours[contour] = {
      status: "passed",
      testFiles: [...spec.testFiles],
      artifacts,
      outputSha256,
    };
  }
  return validateSourceGates({
    schema: HICKS_ACCEPTANCE_SCHEMA,
    generatedAtMs: Date.now(),
    runner: "scripts/run-vitest.mjs",
    networkBoundary: "none",
    contours,
  });
}

export async function verifyHicksPostDeployAcceptance({ installRoot }) {
  const manifestPath = path.join(installRoot, ".openclaw-deploy-manifest.json");
  const manifest = await readJson(manifestPath);
  const acceptance = validateHicksAcceptanceManifest(manifest.hicksAcceptance);
  if (!manifest.buildIdentity?.repoCommit) {
    throw new Error("deployed manifest has no build identity");
  }
  const buildIdentity = await readBuildIdentity(installRoot, manifest.buildIdentity.repoCommit);
  if (!sameBuildIdentity(manifest.buildIdentity, buildIdentity)) {
    throw new Error("installed Hicks build identity does not match its deployment manifest");
  }
  return acceptance;
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

async function stageRuntime({
  sourceRoot,
  installRoot,
  stageRoot,
  platform,
  arch,
  hicksAcceptance,
  repoCommit,
}) {
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

  const buildIdentity = await readBuildIdentity(stageRoot, repoCommit);

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
        buildIdentity,
        hicksAcceptance,
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
  const deploymentId = options.deploymentId ?? crypto.randomUUID();
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
    const repoCommit = await resolveRepoCommit(execute, sourceRoot, env, timeoutMs);
    const sourceGates = await runHicksAcceptanceSuite({
      sourceRoot,
      execute,
      env,
      timeoutMs,
    });
    validateFreshTimestamp(sourceGates.generatedAtMs, Date.now(), "Hicks source gates");
    const hicksAcceptance = validateHicksAcceptanceManifest({
      schema: HICKS_ACCEPTANCE_SCHEMA,
      deploymentId,
      deployedAtMs: Date.now(),
      networkBoundary: "none",
      sourceGates,
      contours: Object.fromEntries(
        HICKS_ACCEPTANCE_CONTOURS.map((contour) => [contour, { status: "awaiting-live" }]),
      ),
    });
    await stageRuntime({
      sourceRoot,
      installRoot,
      stageRoot: paths.stageRoot,
      platform,
      arch,
      hicksAcceptance,
      repoCommit,
    });
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
      return {
        dryRun: true,
        ...paths,
        customization,
        validation,
        hicksAcceptance,
        legacyArchive: null,
      };
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
      const postDeployAcceptance = await verifyHicksPostDeployAcceptance({ installRoot });
      return {
        dryRun: false,
        ...paths,
        customization,
        validation,
        hicksAcceptance: postDeployAcceptance,
        legacyArchive,
      };
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
        hicksAcceptance: result.hicksAcceptance,
      }),
    );
  } catch (error) {
    console.error(
      `[hicks-deploy-runtime] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
