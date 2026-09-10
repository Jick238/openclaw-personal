import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_SMOKE_MARKER,
  HICKS_ACCEPTANCE_CONTOURS,
  HICKS_ACCEPTANCE_MAX_AGE_MS,
  deployRuntime,
  finalizeHicksLiveAcceptance,
  validateHicksAcceptanceManifest,
  verifyHicksPostDeployAcceptance,
} from "../../scripts/hicks-deploy-runtime.mjs";

const CODEX_VERSION = "0.151.0";
const FIXTURE_COMMIT = "a".repeat(40);

async function write(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hicks-deploy-runtime-"));
  const sourceRoot = path.join(root, "source");
  const installRoot = path.join(root, "install");
  const stateDir = path.join(root, "state");
  const workspaceRoot = path.join(root, "workspace");
  const binDir = path.join(root, "bin");
  const alias = `@openai/codex-${process.platform}-${process.arch}`;
  const platformPackage = {
    name: alias,
    version: `${CODEX_VERSION}-${process.platform}-${process.arch}`,
    os: [process.platform],
    cpu: [process.arch],
  };
  const pluginPackage = {
    name: "@openclaw/codex",
    dependencies: { "@openai/codex": CODEX_VERSION },
    openclaw: {
      install: {
        requiredPlatformPackages: [
          "@openai/codex-linux-x64",
          "@openai/codex-linux-arm64",
          "@openai/codex-darwin-x64",
          "@openai/codex-darwin-arm64",
          "@openai/codex-win32-x64",
          "@openai/codex-win32-arm64",
        ],
      },
    },
  };
  const codexPackage = {
    name: "@openai/codex",
    version: CODEX_VERSION,
    optionalDependencies: {
      [alias]: `npm:@openai/codex@${CODEX_VERSION}-${process.platform}-${process.arch}`,
    },
    bin: { codex: "bin/codex.js" },
  };
  const entry = `
const args = process.argv.slice(2);
if (args[0] === "doctor") {
  console.log(JSON.stringify({ ok: true, checksRun: 1, findings: [] }));
} else if (process.env.HICKS_FIXTURE_SMOKE === "fail") {
  console.log(JSON.stringify({ status: "error" }));
} else {
  console.log(JSON.stringify({ status: "ok", text: "${CODEX_SMOKE_MARKER}" }));
}
`;
  for (const runtimeRoot of [sourceRoot, installRoot]) {
    await write(
      path.join(runtimeRoot, "package.json"),
      JSON.stringify({ name: "fixture-openclaw", version: "new" }),
    );
    await write(path.join(runtimeRoot, "openclaw.mjs"), entry);
    await write(
      path.join(runtimeRoot, "dist", "extensions", "codex", "package.json"),
      JSON.stringify(pluginPackage),
    );
    await write(
      path.join(runtimeRoot, "node_modules", "@openai", "codex", "package.json"),
      JSON.stringify(codexPackage),
    );
    await write(
      path.join(runtimeRoot, "node_modules", "@openai", "codex", "bin", "codex.js"),
      "console.log('codex-cli 0.151.0');\n",
    );
    await write(
      path.join(runtimeRoot, "node_modules", ...alias.split("/"), "package.json"),
      JSON.stringify(platformPackage),
    );
    await write(
      path.join(runtimeRoot, "dist", "marker.txt"),
      runtimeRoot === installRoot ? "old" : "new",
    );
    await write(
      path.join(runtimeRoot, "dist", "build-info.json"),
      JSON.stringify({ version: "new", commit: FIXTURE_COMMIT }),
    );
    await write(
      path.join(runtimeRoot, "dist", ".buildstamp"),
      JSON.stringify({ builtAt: Date.now(), head: FIXTURE_COMMIT }),
    );
    await write(
      path.join(runtimeRoot, "dist", ".runtime-postbuildstamp"),
      JSON.stringify({ syncedAt: Date.now(), head: FIXTURE_COMMIT }),
    );
    await write(path.join(runtimeRoot, "dist", "telegram-ingress-worker.runtime.js"), "worker\n");
    await write(
      path.join(runtimeRoot, "dist", "telegram-ingress-drain-factory-fixture.js"),
      "drain\n",
    );
  }
  await fs.mkdir(workspaceRoot, { recursive: true });
  await write(path.join(sourceRoot, "customization", "hicks", "OWNER_POLICY.md"), "owner policy\n");
  await write(
    path.join(sourceRoot, "customization", "hicks", "HICKS_ORCHESTRATOR_TOOL_POLICY.json"),
    '{"schema":1}\n',
  );
  await write(path.join(sourceRoot, "HICKS_ARCHITECTURE_PLAN.md"), "architecture plan\n");
  await write(path.join(sourceRoot, "WORKLOG.md"), "worklog\n");
  await write(
    path.join(sourceRoot, "scripts", "run-vitest.mjs"),
    "console.log('fixture unit tests passed');\n",
  );
  for (const relativePath of [
    "extensions/telegram/src/bot-handlers.guest.ts",
    "extensions/telegram/src/bot-handlers.guest.test.ts",
    "extensions/workboard/src/front-admission.ts",
    "extensions/workboard/src/dispatcher.ts",
    "extensions/workboard/src/front-admission.test.ts",
    "extensions/workboard/src/dispatcher.test.ts",
    "extensions/workboard/src/dispatcher-ownership.test.ts",
    "extensions/workboard/src/lifecycle-sync.test.ts",
    "extensions/workboard/src/lifecycle-sync.restart.test.ts",
    "extensions/workboard/src/lifecycle-sync.ts",
  ]) {
    await write(path.join(sourceRoot, relativePath), "fixture acceptance artifact\n");
  }
  await write(path.join(workspaceRoot, "hicks-reference", "WORKLOG.md"), "old worklog\n");
  await write(path.join(stateDir, "sentinel.txt"), "preserve-me");
  await write(path.join(binDir, "systemctl"), "#!/bin/sh\nexit 0\n");
  await fs.chmod(path.join(binDir, "systemctl"), 0o755);
  await write(path.join(binDir, "git"), `#!/bin/sh\nprintf '%s\\n' '${FIXTURE_COMMIT}'\n`);
  await fs.chmod(path.join(binDir, "git"), 0o755);
  return { root, sourceRoot, installRoot, stateDir, workspaceRoot, binDir };
}

let fixtureRoot: string | undefined;
afterEach(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
  fixtureRoot = undefined;
});

describe("hicks runtime deployment transaction", () => {
  it("dry-runs the complete bundle gate without changing install or external state", async () => {
    const fixture = await makeFixture();
    fixtureRoot = fixture.root;
    const result = await deployRuntime({
      sourceRoot: fixture.sourceRoot,
      installRoot: fixture.installRoot,
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      platform: process.platform,
      arch: process.arch,
      dryRun: true,
      stamp: "fixture-dry-run",
      env: { PATH: `${fixture.binDir}:${process.env.PATH ?? ""}` },
    });

    expect(result.dryRun).toBe(true);
    expect(result.hicksAcceptance?.networkBoundary).toBe("none");
    expect(Object.keys(result.hicksAcceptance?.contours ?? {}).toSorted()).toEqual(
      [...HICKS_ACCEPTANCE_CONTOURS].toSorted(),
    );
    expect(await fs.readFile(path.join(fixture.installRoot, "dist", "marker.txt"), "utf8")).toBe(
      "old",
    );
    expect(await fs.readFile(path.join(fixture.stateDir, "sentinel.txt"), "utf8")).toBe(
      "preserve-me",
    );
    await expect(fs.access(result.backupRoot)).rejects.toThrow();
  });

  it("atomically installs the bundle and retains a full rollback copy after smoke success", async () => {
    const fixture = await makeFixture();
    fixtureRoot = fixture.root;
    const result = await deployRuntime({
      sourceRoot: fixture.sourceRoot,
      installRoot: fixture.installRoot,
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      platform: process.platform,
      arch: process.arch,
      serviceName: "fixture.service",
      stamp: "fixture-success",
      env: { PATH: `${fixture.binDir}:${process.env.PATH ?? ""}` },
    });

    expect(result.dryRun).toBe(false);
    expect(result.hicksAcceptance?.contours.guest.status).toBe("awaiting-live");
    expect(result.hicksAcceptance?.contours["delegation-parallel"].status).toBe("awaiting-live");
    expect(result.hicksAcceptance?.contours["no-fake-progress"].status).toBe("awaiting-live");
    const installedManifest = JSON.parse(
      await fs.readFile(path.join(fixture.installRoot, ".openclaw-deploy-manifest.json"), "utf8"),
    );
    expect(installedManifest.hicksAcceptance).toEqual(result.hicksAcceptance);
    expect(installedManifest.buildIdentity.repoCommit).toBe(FIXTURE_COMMIT);
    expect(installedManifest.buildIdentity.artifacts).toHaveLength(5);
    expect(await fs.readFile(path.join(fixture.installRoot, "dist", "marker.txt"), "utf8")).toBe(
      "new",
    );
    expect(await fs.readFile(path.join(result.backupRoot, "dist", "marker.txt"), "utf8")).toBe(
      "old",
    );
    expect(await fs.readFile(path.join(fixture.stateDir, "sentinel.txt"), "utf8")).toBe(
      "preserve-me",
    );
    expect(
      await fs.readFile(
        path.join(fixture.workspaceRoot, "hicks-reference", "HICKS_ARCHITECTURE_PLAN.md"),
        "utf8",
      ),
    ).toBe("architecture plan\n");
    expect(
      await fs.readFile(
        path.join(fixture.workspaceRoot, "hicks-reference", "OWNER_POLICY.md"),
        "utf8",
      ),
    ).toBe("owner policy\n");
    expect(
      await fs.readFile(path.join(result.customization.backupRoot, "WORKLOG.md"), "utf8"),
    ).toBe("old worklog\n");
    await write(
      path.join(fixture.installRoot, "dist", "telegram-ingress-worker.runtime.js"),
      "tampered\n",
    );
    await expect(
      verifyHicksPostDeployAcceptance({ installRoot: fixture.installRoot }),
    ).rejects.toThrow(/build identity/);
  });

  it("archives legacy install backups outside the canonical bundle", async () => {
    const fixture = await makeFixture();
    fixtureRoot = fixture.root;
    await write(
      path.join(fixture.installRoot, "dist.pre-legacy", "marker.txt"),
      "large legacy backup\n",
    );

    const result = await deployRuntime({
      sourceRoot: fixture.sourceRoot,
      installRoot: fixture.installRoot,
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      platform: process.platform,
      arch: process.arch,
      serviceName: "fixture.service",
      stamp: "fixture-legacy",
      env: { PATH: `${fixture.binDir}:${process.env.PATH ?? ""}` },
    });

    await expect(fs.access(path.join(fixture.installRoot, "dist.pre-legacy"))).rejects.toThrow();
    await expect(fs.access(path.join(result.backupRoot, "dist.pre-legacy"))).rejects.toThrow();
    expect(result.legacyArchive?.entries).toEqual(["dist.pre-legacy"]);
    expect(
      await fs.readFile(
        path.join(
          fixture.stateDir,
          "hicks-install-legacy-backups",
          "fixture-legacy",
          ".manifest.json",
        ),
        "utf8",
      ),
    ).toContain("dist.pre-legacy");
    expect(
      await fs.readFile(
        path.join(
          fixture.stateDir,
          "hicks-install-legacy-backups",
          "fixture-legacy",
          "dist.pre-legacy",
          "marker.txt",
        ),
        "utf8",
      ),
    ).toBe("large legacy backup\n");
  });

  it("leaves legacy backups untouched during a dry-run", async () => {
    const fixture = await makeFixture();
    fixtureRoot = fixture.root;
    await write(path.join(fixture.installRoot, "dist.pre-dry-run", "marker.txt"), "preserve\n");

    await deployRuntime({
      sourceRoot: fixture.sourceRoot,
      installRoot: fixture.installRoot,
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      platform: process.platform,
      arch: process.arch,
      dryRun: true,
      stamp: "fixture-legacy-dry-run",
      env: { PATH: `${fixture.binDir}:${process.env.PATH ?? ""}` },
    });

    expect(
      await fs.readFile(path.join(fixture.installRoot, "dist.pre-dry-run", "marker.txt"), "utf8"),
    ).toBe("preserve\n");
    await expect(
      fs.access(path.join(fixture.stateDir, "hicks-install-legacy-backups")),
    ).rejects.toThrow();
  });

  it("rejects state and workspace roots inside the install root", async () => {
    const fixture = await makeFixture();
    fixtureRoot = fixture.root;
    const options = {
      sourceRoot: fixture.sourceRoot,
      installRoot: fixture.installRoot,
      platform: process.platform,
      arch: process.arch,
      dryRun: true,
      env: { PATH: `${fixture.binDir}:${process.env.PATH ?? ""}` },
    };

    await expect(
      deployRuntime({
        ...options,
        stateDir: path.join(fixture.installRoot, "nested-state"),
        workspaceRoot: fixture.workspaceRoot,
      }),
    ).rejects.toThrow(/OPENCLAW_STATE_DIR must remain outside/);
    await expect(
      deployRuntime({
        ...options,
        stateDir: fixture.stateDir,
        workspaceRoot: path.join(fixture.installRoot, "nested-workspace"),
      }),
    ).rejects.toThrow(/Hicks workspace root must remain outside/);
  });

  it("rejects a symlinked install root before staging", async () => {
    const fixture = await makeFixture();
    fixtureRoot = fixture.root;
    const installLink = path.join(fixture.root, "install-link");
    await fs.symlink(fixture.installRoot, installLink);

    await expect(
      deployRuntime({
        sourceRoot: fixture.sourceRoot,
        installRoot: installLink,
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        platform: process.platform,
        arch: process.arch,
        dryRun: true,
        stamp: "fixture-symlink-install",
        env: { PATH: `${fixture.binDir}:${process.env.PATH ?? ""}` },
      }),
    ).rejects.toThrow(/install root must be a real directory/);
    expect(await fs.readFile(path.join(fixture.installRoot, "dist", "marker.txt"), "utf8")).toBe(
      "old",
    );
    await expect(
      fs.access(path.join(fixture.workspaceRoot, "hicks-reference")),
    ).resolves.toBeUndefined();
  });

  it("restarts and checks the old service when cutover rename fails", async () => {
    const fixture = await makeFixture();
    fixtureRoot = fixture.root;
    await write(
      path.join(fixture.binDir, "systemctl"),
      '#!/bin/sh\necho "$*" >> "$HICKS_SYSTEMCTL_LOG"\nexit 0\n',
    );
    await fs.chmod(path.join(fixture.binDir, "systemctl"), 0o755);
    const systemctlLog = path.join(fixture.root, "systemctl.log");
    const originalRename = fs.rename;
    const rename = vi.spyOn(fs, "rename");
    rename.mockImplementation(async (from, to) => {
      if (String(from) === fixture.installRoot && String(to).includes(".install.backup-")) {
        throw new Error("cutover rename failed");
      }
      return originalRename(from, to);
    });
    try {
      await expect(
        deployRuntime({
          sourceRoot: fixture.sourceRoot,
          installRoot: fixture.installRoot,
          stateDir: fixture.stateDir,
          workspaceRoot: fixture.workspaceRoot,
          platform: process.platform,
          arch: process.arch,
          serviceName: "fixture.service",
          stamp: "fixture-rename-failure",
          env: {
            PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
            HICKS_SYSTEMCTL_LOG: systemctlLog,
          },
        }),
      ).rejects.toThrow(/old Gateway restarted/);
    } finally {
      rename.mockRestore();
    }
    const calls = await fs.readFile(systemctlLog, "utf8");
    expect(calls).toContain("stop fixture.service");
    expect(calls).toContain("start fixture.service");
    expect(calls).toContain("is-active --quiet fixture.service");
    expect(await fs.readFile(path.join(fixture.installRoot, "dist", "marker.txt"), "utf8")).toBe(
      "old",
    );
  });

  it("preserves a partial legacy archive when its restore also fails", async () => {
    const fixture = await makeFixture();
    fixtureRoot = fixture.root;
    await write(path.join(fixture.installRoot, "dist.pre-a", "marker.txt"), "a\n");
    await write(path.join(fixture.installRoot, "dist.pre-b", "marker.txt"), "b\n");
    const originalRename = fs.rename;
    const rename = vi.spyOn(fs, "rename");
    rename.mockImplementation(async (from, to) => {
      if (path.basename(String(from)) === "dist.pre-b") {
        throw new Error("archive move failed");
      }
      if (
        String(from).includes("hicks-install-legacy-backups") &&
        path.basename(String(from)) === "dist.pre-a"
      ) {
        throw new Error("archive restore failed");
      }
      return originalRename(from, to);
    });
    try {
      await expect(
        deployRuntime({
          sourceRoot: fixture.sourceRoot,
          installRoot: fixture.installRoot,
          stateDir: fixture.stateDir,
          workspaceRoot: fixture.workspaceRoot,
          platform: process.platform,
          arch: process.arch,
          serviceName: "fixture.service",
          stamp: "fixture-partial-archive",
          env: { PATH: `${fixture.binDir}:${process.env.PATH ?? ""}` },
        }),
      ).rejects.toThrow(/recovery data preserved at/);
    } finally {
      rename.mockRestore();
    }
    const archive = path.join(
      fixture.stateDir,
      "hicks-install-legacy-backups",
      "fixture-partial-archive",
    );
    expect(await fs.readFile(path.join(archive, "dist.pre-a", "marker.txt"), "utf8")).toBe("a\n");
    expect(
      await fs.readFile(
        path.join(
          fixture.root,
          ".install.backup-fixture-partial-archive",
          "dist.pre-b",
          "marker.txt",
        ),
        "utf8",
      ),
    ).toBe("b\n");
  });

  it("restores the complete old bundle when the post-cutover smoke omits its marker", async () => {
    const fixture = await makeFixture();
    fixtureRoot = fixture.root;
    await write(path.join(fixture.installRoot, "dist.pre-legacy", "marker.txt"), "restore-me\n");
    await expect(
      deployRuntime({
        sourceRoot: fixture.sourceRoot,
        installRoot: fixture.installRoot,
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        platform: process.platform,
        arch: process.arch,
        serviceName: "fixture.service",
        stamp: "fixture-rollback",
        env: {
          PATH: `${fixture.binDir}:${process.env.PATH ?? ""}`,
          HICKS_FIXTURE_SMOKE: "fail",
        },
      }),
    ).rejects.toThrow(/full bundle was rolled back/);

    expect(await fs.readFile(path.join(fixture.installRoot, "dist", "marker.txt"), "utf8")).toBe(
      "old",
    );
    expect(
      await fs.readFile(path.join(fixture.installRoot, "dist.pre-legacy", "marker.txt"), "utf8"),
    ).toBe("restore-me\n");
    expect(await fs.readFile(path.join(fixture.stateDir, "sentinel.txt"), "utf8")).toBe(
      "preserve-me",
    );
    expect(
      await fs.readFile(
        path.join(fixture.root, ".install.failed-fixture-rollback", "dist", "marker.txt"),
        "utf8",
      ),
    ).toBe("new");
    expect(
      await fs.readFile(path.join(fixture.workspaceRoot, "hicks-reference", "WORKLOG.md"), "utf8"),
    ).toBe("old worklog\n");
    expect(
      await fs.readFile(
        path.join(fixture.workspaceRoot, ".hicks-reference.failed-fixture-rollback", "WORKLOG.md"),
        "utf8",
      ),
    ).toBe("worklog\n");
  });

  it("fails closed when the Hicks workspace is absent", async () => {
    const fixture = await makeFixture();
    fixtureRoot = fixture.root;
    await expect(
      deployRuntime({
        sourceRoot: fixture.sourceRoot,
        installRoot: fixture.installRoot,
        stateDir: fixture.stateDir,
        workspaceRoot: path.join(fixture.root, "missing-workspace"),
        platform: process.platform,
        arch: process.arch,
        dryRun: true,
        stamp: "fixture-missing-workspace",
      }),
    ).rejects.toThrow(/Hicks workspace root is missing/);
  });

  it("fails closed when the Guest regression artifact is absent", async () => {
    const fixture = await makeFixture();
    fixtureRoot = fixture.root;
    await fs.rm(
      path.join(fixture.sourceRoot, "extensions/telegram/src/bot-handlers.guest.test.ts"),
    );

    await expect(
      deployRuntime({
        sourceRoot: fixture.sourceRoot,
        installRoot: fixture.installRoot,
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        platform: process.platform,
        arch: process.arch,
        dryRun: true,
        stamp: "fixture-missing-guest-proof",
        env: { PATH: `${fixture.binDir}:${process.env.PATH ?? ""}` },
      }),
    ).rejects.toThrow(/Hicks acceptance artifact is missing/);
  });

  it("rejects missing and stale contour evidence", async () => {
    const fixture = await makeFixture();
    fixtureRoot = fixture.root;
    const result = await deployRuntime({
      sourceRoot: fixture.sourceRoot,
      installRoot: fixture.installRoot,
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      platform: process.platform,
      arch: process.arch,
      dryRun: true,
      stamp: "fixture-acceptance-manifest",
      env: { PATH: `${fixture.binDir}:${process.env.PATH ?? ""}` },
    });
    const missingContour = structuredClone(result.hicksAcceptance);
    delete missingContour.contours.guest;
    expect(() => validateHicksAcceptanceManifest(missingContour)).toThrow(/contours mismatch/);

    const stale = structuredClone(result.hicksAcceptance);
    stale.deployedAtMs = Date.now() - HICKS_ACCEPTANCE_MAX_AGE_MS - 1;
    stale.sourceGates.generatedAtMs = stale.deployedAtMs;
    expect(() => validateHicksAcceptanceManifest(stale)).not.toThrow();
  });

  it("keeps deployment acceptance in local unit tests without Telegram sends", async () => {
    const fixture = await makeFixture();
    fixtureRoot = fixture.root;
    const calls: Array<{ command: string; args: string[] }> = [];
    const execute = async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args.includes("rev-parse")) {
        return { command, args, status: 0, stdout: `${FIXTURE_COMMIT}\n`, stderr: "" };
      }
      if (args.includes("doctor")) {
        return {
          command,
          args,
          status: 0,
          stdout: JSON.stringify({ ok: true, findings: [] }),
          stderr: "",
        };
      }
      if (args.includes("agent")) {
        return { command, args, status: 0, stdout: CODEX_SMOKE_MARKER, stderr: "" };
      }
      return { command, args, status: 0, stdout: "unit tests passed", stderr: "" };
    };
    const result = await deployRuntime(
      {
        sourceRoot: fixture.sourceRoot,
        installRoot: fixture.installRoot,
        stateDir: fixture.stateDir,
        workspaceRoot: fixture.workspaceRoot,
        platform: process.platform,
        arch: process.arch,
        dryRun: true,
        stamp: "fixture-local-acceptance",
      },
      { execute },
    );

    expect(result.hicksAcceptance?.networkBoundary).toBe("none");
    expect(
      calls.filter(({ args }) => args.some((arg) => arg.endsWith("run-vitest.mjs"))),
    ).toHaveLength(1);
    expect(calls.some(({ args }) => args.includes("send"))).toBe(false);
  });

  it("finalizes only correlated live evidence for all Hicks contours", async () => {
    const fixture = await makeFixture();
    fixtureRoot = fixture.root;
    const result = await deployRuntime({
      sourceRoot: fixture.sourceRoot,
      installRoot: fixture.installRoot,
      stateDir: fixture.stateDir,
      workspaceRoot: fixture.workspaceRoot,
      platform: process.platform,
      arch: process.arch,
      dryRun: true,
      stamp: "fixture-live-finalization",
      env: { PATH: `${fixture.binDir}:${process.env.PATH ?? ""}` },
    });
    const nowMs = Date.now();
    const deploymentManifest = { hicksAcceptance: result.hicksAcceptance };
    const evidenceManifest = {
      schema: 2,
      deploymentId: result.hicksAcceptance.deploymentId,
      createdAtMs: nowMs,
      contours: {
        guest: {
          status: "passed",
          telegramUpdateId: 182010731,
          answerGuestQuery: true,
          providerRequestId: "provider-request-1",
        },
        "delegation-parallel": {
          status: "passed",
          frontAdmissionId: "admission-1",
          workerIds: ["worker-a", "worker-b"],
          overlapObserved: true,
          parentReconciled: true,
          finalDeliveryCount: 1,
        },
        "no-fake-progress": {
          status: "passed",
          toolEvidenceOccurred: true,
          toolEvidenceAtMs: nowMs - 10,
          finalAtMs: nowMs,
          unsupportedSuccess: false,
        },
      },
    };

    const finalized = finalizeHicksLiveAcceptance({
      deploymentManifest,
      evidenceManifest,
      nowMs,
    });
    expect(finalized.hicksAcceptance.contours).toEqual({
      guest: { status: "passed" },
      "delegation-parallel": { status: "passed" },
      "no-fake-progress": { status: "passed" },
    });
    expect(finalized.hicksAcceptance.liveEvidence).toEqual(evidenceManifest);
    expect(() => validateHicksAcceptanceManifest(finalized.hicksAcceptance)).not.toThrow();
    expect(() =>
      finalizeHicksLiveAcceptance({
        deploymentManifest: finalized,
        evidenceManifest,
        nowMs: nowMs + 1,
      }),
    ).toThrow(/not awaiting/);

    expect(() =>
      finalizeHicksLiveAcceptance({
        deploymentManifest,
        evidenceManifest: { ...evidenceManifest, deploymentId: "wrong-deployment" },
        nowMs,
      }),
    ).toThrow(/deployment identity/);
    expect(() =>
      finalizeHicksLiveAcceptance({
        deploymentManifest,
        evidenceManifest: {
          ...evidenceManifest,
          contours: {
            ...evidenceManifest.contours,
            guest: { status: "passed" },
          },
        },
        nowMs,
      }),
    ).toThrow(/Guest live evidence is incomplete/);
    expect(() =>
      finalizeHicksLiveAcceptance({
        deploymentManifest,
        evidenceManifest: {
          ...evidenceManifest,
          createdAtMs: nowMs - HICKS_ACCEPTANCE_MAX_AGE_MS - 1,
        },
        nowMs,
      }),
    ).toThrow(/stale/);
  });
});
