import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_SMOKE_MARKER, deployRuntime } from "../../scripts/hicks-deploy-runtime.mjs";

const CODEX_VERSION = "0.151.0";

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
  }
  await fs.mkdir(workspaceRoot, { recursive: true });
  await write(path.join(sourceRoot, "customization", "hicks", "OWNER_POLICY.md"), "owner policy\n");
  await write(
    path.join(sourceRoot, "customization", "hicks", "HICKS_ORCHESTRATOR_TOOL_POLICY.json"),
    '{"schema":1}\n',
  );
  await write(path.join(sourceRoot, "HICKS_ARCHITECTURE_PLAN.md"), "architecture plan\n");
  await write(path.join(sourceRoot, "WORKLOG.md"), "worklog\n");
  await write(path.join(workspaceRoot, "hicks-reference", "WORKLOG.md"), "old worklog\n");
  await write(path.join(stateDir, "sentinel.txt"), "preserve-me");
  await write(path.join(binDir, "systemctl"), "#!/bin/sh\nexit 0\n");
  await fs.chmod(path.join(binDir, "systemctl"), 0o755);
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
});
