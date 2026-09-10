#!/usr/bin/env node
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { finalizeHicksLiveAcceptance } from "./hicks-deploy-runtime.mjs";

const CONTOURS = Object.freeze(["guest", "delegation-parallel", "no-fake-progress"]);
const MAX_ARTIFACT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const SECRET_KEY = /(?:token|secret|password|credential|cookie|authorization|api[_-]?key)/iu;
const TRACKED_GUEST_RUNNER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.agents/skills/telegram-e2e-userbot/scripts/run-mock-sut-user-e2e.mjs",
);
const TRACKED_TELEGRAM_DOCTOR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.agents/skills/telegram-e2e-userbot/scripts/telegram-test-doctor.mjs",
);

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function redact(value, secrets = []) {
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SECRET_KEY.test(key) ? "<redacted>" : redact(entry, secrets),
      ]),
    );
  }
  if (typeof value !== "string") {
    return value;
  }
  return secrets.reduce(
    (result, secret) => (secret ? result.replaceAll(String(secret), "<redacted>") : result),
    value,
  );
}

export async function writeJsonArtifact(proofDir, name, value, secrets = []) {
  const body = `${JSON.stringify(redact(value, secrets), null, 2)}\n`;
  const bytes = Buffer.byteLength(body);
  if (bytes > MAX_ARTIFACT_BYTES) {
    throw new Error(`evidence artifact exceeds ${MAX_ARTIFACT_BYTES} bytes: ${name}`);
  }
  await fs.mkdir(proofDir, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(proofDir, name);
  await fs.writeFile(artifactPath, body, { mode: 0o600 });
  const digest = sha256(body);
  await fs.writeFile(`${artifactPath}.sha256`, `${digest}  ${name}\n`, { mode: 0o600 });
  return { name, bytes, sha256: digest };
}

function blocked(reason, details = {}) {
  return { status: "blocked", completed: false, reason, ...details };
}

function parseJsonOutput(result, label) {
  if (!result || result.status !== 0 || result.timedOut) {
    throw new Error(`${label} did not complete successfully`);
  }
  try {
    return JSON.parse(String(result.stdout || "").trim());
  } catch (error) {
    throw new Error(`${label} did not return JSON`, { cause: error });
  }
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
    const limit = options.maxOutputBytes ?? 128 * 1024;
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-limit);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-limit);
    });
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : null;
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({ status: status ?? 1, stdout, stderr, timedOut, ...(signal ? { signal } : {}) });
    });
  });
}

async function regularFile(filePath, label) {
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0) {
      throw new Error(`${label} must be a non-empty regular file`);
    }
  } catch (error) {
    throw new Error(`${label} is unavailable`, { cause: error });
  }
}

async function readWorkboard({ entry, boardId, execute, env, timeoutMs }) {
  const result = await execute(
    process.execPath,
    [
      entry,
      "gateway",
      "call",
      "workboard.cards.list",
      "--params",
      JSON.stringify({ boardId }),
      "--json",
    ],
    { env, timeoutMs },
  );
  const payload = parseJsonOutput(result, "Workboard cards.list");
  if (!payload || !Array.isArray(payload.cards)) {
    throw new Error("Workboard cards.list returned no cards array");
  }
  return payload;
}

async function preflight(options, execute, fetchImpl) {
  const reasons = [];
  const installRoot = path.resolve(options.installRoot || "");
  if (!options.installRoot) {
    reasons.push("installed runtime root is not configured");
  }
  let entry;
  let manifest;
  if (options.installRoot) {
    try {
      const stats = await fs.lstat(installRoot);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error("not a real directory");
      }
      const candidate = path.join(installRoot, "openclaw.mjs");
      const fallback = path.join(installRoot, "dist", "entry.js");
      entry = await fs
        .access(candidate)
        .then(() => candidate)
        .catch(() => fallback);
      await regularFile(entry, "installed runtime entry");
      manifest = JSON.parse(
        await fs.readFile(path.join(installRoot, ".openclaw-deploy-manifest.json"), "utf8"),
      );
      if (!manifest?.hicksAcceptance?.deploymentId) {
        throw new Error("deployment acceptance identity missing");
      }
      if (!Array.isArray(manifest.hicksAcceptance?.contours)) {
        // The deployed manifest uses an object map; reject malformed or caller-supplied summaries.
        if (
          !manifest.hicksAcceptance?.contours ||
          typeof manifest.hicksAcceptance.contours !== "object"
        ) {
          throw new Error("deployment acceptance contours missing");
        }
      }
    } catch (error) {
      reasons.push(`installed runtime/deployment manifest unavailable: ${error.message}`);
    }
  }
  if (entry) {
    const version = await execute(process.execPath, [entry, "--version"], {
      env: options.env,
      timeoutMs: options.timeoutMs,
    });
    if (version.status !== 0 || !String(version.stdout || "").trim()) {
      reasons.push("installed runtime --version probe failed");
    }
  }
  const gatewayUrl = options.gatewayUrl || process.env.HICKS_LIVE_GATEWAY_URL;
  if (!gatewayUrl) {
    reasons.push("deployed Gateway URL is not configured");
  } else {
    try {
      const response = await fetchImpl(new URL("/readyz", gatewayUrl), {
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const payload = await response.json();
      if (!response.ok || (payload.ready !== true && payload.ok !== true)) {
        reasons.push("deployed Gateway /readyz is not ready");
      }
    } catch (error) {
      reasons.push(`deployed Gateway /readyz unavailable: ${error.message}`);
    }
  }
  let workboard;
  if (entry) {
    try {
      workboard = await readWorkboard({
        entry,
        boardId: options.boardId || "hicks-front",
        execute,
        env: options.env,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      reasons.push(`Workboard unavailable: ${error.message}`);
    }
  }
  const doctor = options.doctorCommand || process.env.HICKS_LIVE_TELEGRAM_DOCTOR;
  try {
    const result = doctor
      ? await execute(doctor, [], { env: options.env, timeoutMs: options.timeoutMs })
      : await execute(process.execPath, [TRACKED_TELEGRAM_DOCTOR], {
          cwd: options.harnessRoot || process.cwd(),
          env: options.env,
          timeoutMs: options.timeoutMs,
        });
    const payload = parseJsonOutput(result, "Telegram Test Server doctor");
    const required = ["credentialLoaded", "testDc", "tdlibAuthorized", "sutBot", "botApiProxy"];
    if (payload.ok !== true || required.some((key) => payload[key] !== true)) {
      reasons.push(
        "Telegram Test Server doctor did not prove entitlement and userbot authorization",
      );
    }
  } catch (error) {
    reasons.push(`Telegram Test Server/userbot unavailable: ${error.message}`);
  }
  return {
    status: reasons.length ? "blocked" : "ready",
    reasons,
    ...(entry ? { entry } : {}),
    ...(manifest ? { deploymentId: manifest.hicksAcceptance.deploymentId } : {}),
    ...(workboard ? { workboardAvailable: true } : {}),
  };
}

export function actualGuestEvidence(payload) {
  const proof = payload?.guestProof ?? payload?.scenario?.guestProof;
  const correlation = proof?.correlation;
  if (
    payload?.completed !== true ||
    proof?.status !== "passed" ||
    proof?.orderedChain !== true ||
    !Number.isSafeInteger(correlation?.updateId) ||
    !Number.isSafeInteger(correlation?.providerSeq) ||
    !Number.isSafeInteger(correlation?.answerOrdinal) ||
    !Number.isSafeInteger(correlation?.outboundMessageId) ||
    typeof correlation?.guestQueryHash !== "string" ||
    !/^[a-f0-9]{24}$/u.test(correlation.guestQueryHash)
  ) {
    throw new Error("Guest evidence lacks one correlated live Telegram chain");
  }
  return {
    status: "passed",
    telegramUpdateId: correlation.updateId,
    answerGuestQuery: true,
    providerRequestId: `mock-provider:${correlation.providerSeq}`,
    telegramMessageId: correlation.outboundMessageId,
    guestQueryHash: correlation.guestQueryHash,
  };
}

function executionWindow(card) {
  const attempts = card?.metadata?.attempts || [];
  const starts = attempts.map((entry) => entry.startedAt).filter(Number.isSafeInteger);
  const ends = attempts.map((entry) => entry.endedAt).filter(Number.isSafeInteger);
  if (Number.isSafeInteger(card?.execution?.startedAt)) {
    starts.push(card.execution.startedAt);
  }
  if (Number.isSafeInteger(card?.execution?.updatedAt)) {
    ends.push(card.execution.updatedAt);
  }
  return starts.length && ends.length
    ? { start: Math.min(...starts), end: Math.max(...ends) }
    : null;
}

export function validateParallelEvidence(payload, transport, nonce) {
  const cards = Array.isArray(payload?.cards) ? payload.cards : [];
  const parent = cards.find((card) => String(JSON.stringify(card)).includes(nonce));
  if (!parent?.id) {
    throw new Error("nonce-bearing Workboard parent was not observed");
  }
  const ids = new Set(parent.metadata?.automation?.createdCardIds || []);
  const children = cards.filter(
    (card) => ids.has(card.id) || card.metadata?.automation?.createdByCardId === parent.id,
  );
  const workers = children
    .map((card) => ({
      id: card.id,
      runId: card.runId || card.execution?.runId,
      sessionKey: card.sessionKey || card.execution?.sessionKey,
      window: executionWindow(card),
    }))
    .filter((worker) => worker.runId && worker.sessionKey && worker.window);
  const windows = workers.map((worker) => worker.window);
  const overlap =
    workers.length >= 2 &&
    Math.max(...windows.map((window) => window.start)) <
      Math.min(...windows.map((window) => window.end));
  const finalDeliveries = Array.isArray(transport?.finalDeliveries)
    ? transport.finalDeliveries.filter(
        (event) =>
          event?.messageId &&
          typeof event?.textHash === "string" &&
          /^[a-f0-9]{64}$/u.test(event.textHash) &&
          Number.isSafeInteger(event?.observedAtMs),
      )
    : [];
  if (
    workers.length < 2 ||
    new Set(workers.map((worker) => `${worker.runId}:${worker.sessionKey}`)).size < 2 ||
    !overlap ||
    parent.status !== "done" ||
    !Number.isSafeInteger(parent.completedAt) ||
    !children.every((child) => child.status === "done" || child.status === "blocked") ||
    finalDeliveries.length !== 1 ||
    finalDeliveries[0]?.observedAtMs < parent.completedAt ||
    transport?.nonce !== nonce ||
    !transport?.sentMessageId
  ) {
    throw new Error("parallel delegation evidence is incomplete or not independently observed");
  }
  return {
    status: "passed",
    frontAdmissionId: parent.id,
    workerIds: workers.map((worker) => worker.id),
    overlapObserved: true,
    parentReconciled: true,
    finalDeliveryCount: 1,
    finalDeliveryMessageId: finalDeliveries[0].messageId,
  };
}

export function validateNoFakeProgress(payload, transport, nonce) {
  const cards = Array.isArray(payload?.cards) ? payload.cards : [];
  const parent = cards.find(
    (card) =>
      card.status === "done" &&
      Number.isSafeInteger(card.completedAt) &&
      (!nonce || String(JSON.stringify(card)).includes(nonce)),
  );
  if (!parent) {
    throw new Error("no reconciled Workboard parent is available for no-fake proof");
  }
  const childIds = new Set(parent.metadata?.automation?.createdCardIds || []);
  const evidenceCards = cards.filter(
    (card) =>
      card.id === parent.id ||
      childIds.has(card.id) ||
      card.metadata?.automation?.createdByCardId === parent.id,
  );
  const evidenceTimes = evidenceCards
    .flatMap((card) => (card.metadata?.proof || []).concat(card.metadata?.workerLogs || []))
    .map((entry) => entry.createdAt || entry.atMs || entry.timestampMs)
    .filter(Number.isSafeInteger)
    .filter((atMs) => atMs <= parent.completedAt);
  if (evidenceTimes.length === 0) {
    throw new Error("no timestamped tool/workboard evidence precedes final state");
  }
  const finals = Array.isArray(transport?.finalDeliveries)
    ? transport.finalDeliveries.filter(
        (event) =>
          event?.messageId &&
          typeof event?.textHash === "string" &&
          /^[a-f0-9]{64}$/u.test(event.textHash) &&
          Number.isSafeInteger(event?.observedAtMs),
      )
    : [];
  if (finals.length !== 1 || finals[0].observedAtMs < parent.completedAt) {
    throw new Error("Front final delivery was not observed after terminal Workboard evidence");
  }
  return {
    status: "passed",
    toolEvidenceOccurred: true,
    toolEvidenceAtMs: Math.max(...evidenceTimes),
    finalAtMs: finals[0].observedAtMs,
    unsupportedSuccess: false,
  };
}

async function runTrackedGuest(options, execute) {
  const record = path.join(options.proofDir, "guest-events.ndjson");
  const output = path.join(options.proofDir, "guest-summary.json");
  const args = [
    "--guest",
    "--text",
    `@{sut} Reply with Hicks guest nonce ${options.nonce}.`,
    "--record",
    record,
    "--output",
    output,
  ];
  const result = options.guestTransportCommand
    ? await options.guestTransportCommand({
        runner: TRACKED_GUEST_RUNNER,
        args,
        execute,
        env: options.env,
        timeoutMs: options.timeoutMs,
      })
    : await execute(process.execPath, [TRACKED_GUEST_RUNNER, ...args], {
        cwd: options.harnessRoot || process.cwd(),
        env: { ...options.env, HICKS_E2E_RUNTIME_ROOT: options.installRoot },
        timeoutMs: options.timeoutMs,
      });
  const payload =
    typeof result === "object" && result !== null && !Array.isArray(result)
      ? result
      : parseJsonOutput(result, "tracked Telegram --guest runner");
  return actualGuestEvidence(payload);
}

async function runOwnerTransport(options, execute) {
  if (!options.ownerTransportCommand) {
    throw new Error("owner DM transport seam is missing; cannot send a real deployed SUT task");
  }
  const result = await options.ownerTransportCommand({
    nonce: options.nonce,
    execute,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  return typeof result === "object" && result !== null && !Array.isArray(result)
    ? result
    : parseJsonOutput(result, "owner Telegram transport");
}

export async function pollWorkboard(read, ready, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 1_000;
  const now = options.now ?? (() => Date.now());
  const delay =
    options.delay ??
    ((ms) =>
      new Promise((resolveDelay) => {
        setTimeout(resolveDelay, ms);
      }));
  const deadline = now() + timeoutMs;
  let latest;
  while (now() <= deadline) {
    latest = await read();
    if (ready(latest)) {
      return latest;
    }
    if (now() >= deadline) {
      break;
    }
    await delay(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
  throw new Error("Workboard polling deadline expired before terminal evidence appeared");
}

export async function runHicksLiveAcceptance(options = {}, dependencies = {}) {
  const execute = dependencies.execute || runCommand;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const now = dependencies.now || (() => Date.now());
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const proofDir = path.resolve(
    options.proofDir || process.env.HICKS_LIVE_PROOF_DIR || ".artifacts/hicks-live",
  );
  const nonce = options.nonce || `HICKS_LIVE_${now()}`;
  const secrets = Object.entries({ ...process.env, ...options.env })
    .filter(([key, value]) => value && SECRET_KEY.test(key))
    .map(([, value]) => value);
  const guestTransportCommand =
    typeof options.guestTransportCommand === "string"
      ? ({ runner, args, execute: invoke, env, timeoutMs: commandTimeoutMs }) =>
          invoke(options.guestTransportCommand, [], {
            env: { ...env, HICKS_LIVE_REQUEST_JSON: JSON.stringify({ runner, args }) },
            timeoutMs: commandTimeoutMs,
          })
      : options.guestTransportCommand;
  const ownerTransportCommand =
    typeof options.ownerTransportCommand === "string"
      ? ({ nonce: requestNonce, execute: invoke, env, timeoutMs: commandTimeoutMs }) =>
          invoke(options.ownerTransportCommand, [], {
            env: { ...env, HICKS_LIVE_REQUEST_JSON: JSON.stringify({ nonce: requestNonce }) },
            timeoutMs: commandTimeoutMs,
          })
      : options.ownerTransportCommand;
  const contours = Object.fromEntries(
    CONTOURS.map((name) => [name, blocked("preflight not complete")]),
  );
  let preflightResult;
  try {
    preflightResult = await preflight({ ...options, timeoutMs }, execute, fetchImpl);
  } catch (error) {
    preflightResult = { status: "blocked", reasons: [error.message] };
  }
  if (preflightResult.status === "ready") {
    try {
      contours.guest = {
        status: "passed",
        ...(await runTrackedGuest(
          { ...options, guestTransportCommand, proofDir, nonce, timeoutMs },
          execute,
        )),
      };
    } catch (error) {
      contours.guest = blocked(error.message);
    }
    try {
      const transport = await runOwnerTransport(
        { ...options, ownerTransportCommand, proofDir, nonce, timeoutMs },
        execute,
      );
      const cards = await pollWorkboard(
        () =>
          readWorkboard({
            entry: preflightResult.entry,
            boardId: options.boardId || "hicks-front",
            execute,
            env: options.env,
            timeoutMs,
          }),
        (payload) =>
          payload.cards.some(
            (card) => String(JSON.stringify(card)).includes(nonce) && card.status === "done",
          ),
        { timeoutMs, intervalMs: options.pollMs, now },
      );
      contours["delegation-parallel"] = validateParallelEvidence(cards, transport, nonce);
      contours["no-fake-progress"] = validateNoFakeProgress(cards, transport, nonce);
    } catch (error) {
      contours["delegation-parallel"] = blocked(error.message);
      contours["no-fake-progress"] = blocked(error.message);
    }
  } else {
    for (const contour of CONTOURS) {
      contours[contour] = blocked("preflight blocked", { reasons: preflightResult.reasons });
    }
  }
  const status = Object.values(contours).every((contour) => contour.status === "passed")
    ? "passed"
    : "blocked";
  const result = {
    schema: 2,
    status,
    completed: status === "passed",
    deploymentId: preflightResult.deploymentId || null,
    nonce,
    preflight: preflightResult,
    contours,
    createdAtMs: now(),
  };
  const artifact = await writeJsonArtifact(proofDir, "hicks-live-acceptance.json", result, secrets);
  if (status === "passed" && options.finalize === true) {
    const manifestPath = path.join(
      path.resolve(options.installRoot),
      ".openclaw-deploy-manifest.json",
    );
    const deploymentManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const finalized = finalizeHicksLiveAcceptance({
      deploymentManifest,
      evidenceManifest: result,
      nowMs: now(),
    });
    const temporary = `${manifestPath}.finalize-${process.pid}`;
    await fs.writeFile(temporary, `${JSON.stringify(finalized, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, manifestPath);
    return { ...result, artifact, finalized: true };
  }
  return { ...result, artifact, finalized: false };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--install-root") {
      options.installRoot = argv[++index];
    } else if (arg === "--proof-dir") {
      options.proofDir = argv[++index];
    } else if (arg === "--gateway-url") {
      options.gatewayUrl = argv[++index];
    } else if (arg === "--doctor-command") {
      options.doctorCommand = argv[++index];
    } else if (arg === "--guest-transport-command") {
      options.guestTransportCommand = argv[++index];
    } else if (arg === "--owner-transport-command") {
      options.ownerTransportCommand = argv[++index];
    } else if (arg === "--board-id") {
      options.boardId = argv[++index];
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[++index]);
    } else if (arg === "--poll-ms") {
      options.pollMs = Number(argv[++index]);
    } else if (arg === "--finalize") {
      options.finalize = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/hicks-live-acceptance.mjs --install-root <installed-runtime> --proof-dir <private-dir>",
      );
      return null;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const options = parseArgs(process.argv.slice(2));
  if (options) {
    runHicksLiveAcceptance(options)
      .then((result) => {
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.status === "passed" ? 0 : 2;
      })
      .catch((error) => {
        console.log(JSON.stringify(blocked(error.message), null, 2));
        process.exitCode = 2;
      });
  }
}
