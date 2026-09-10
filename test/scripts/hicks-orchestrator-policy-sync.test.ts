import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyOrchestratorToolPolicy } from "../../scripts/hicks-orchestrator-policy-sync.mjs";

const policy = {
  schema: 1,
  agentId: "hicks-orchestrator",
  profile: "full",
  deny: ["hicks_delegate"],
  alsoAllow: ["workboard_create", "workboard_claim", "workboard_decompose", "workboard_dispatch"],
  contract: { telegramBinding: false, maxSpawnDepth: 2 },
};

let root: string | undefined;
afterEach(async () => {
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
  }
  root = undefined;
});

describe("Hicks Orchestrator policy owner", () => {
  it("backs up and atomically applies the versioned additive policy", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hicks-policy-sync-"));
    const configPath = path.join(root, "openclaw.json");
    const policyPath = path.join(root, "policy.json");
    const backupPath = path.join(root, "backup", "openclaw.json");
    const config = {
      agents: {
        entries: {
          "hicks-orchestrator": {
            workspace: "/workspace-orchestrator",
            tools: { allow: ["stale"], deny: ["message"] },
          },
        },
      },
    };
    await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    await fs.writeFile(policyPath, `${JSON.stringify(policy)}\n`);

    const result = await applyOrchestratorToolPolicy({ configPath, policyPath, backupPath });
    expect(result.alsoAllowCount).toBe(4);
    expect(
      JSON.parse(await fs.readFile(backupPath, "utf8")).agents.entries["hicks-orchestrator"].tools
        .allow,
    ).toEqual(["stale"]);
    expect((await fs.stat(configPath)).uid).toBe((await fs.stat(backupPath)).uid);
    expect((await fs.stat(configPath)).gid).toBe((await fs.stat(backupPath)).gid);
    const updated = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(updated.agents.entries["hicks-orchestrator"].tools).toEqual({
      profile: "full",
      alsoAllow: policy.alsoAllow,
      deny: ["message", "hicks_delegate"],
    });
  });

  it("fails closed when the policy would attach a Telegram binding", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hicks-policy-sync-"));
    const configPath = path.join(root, "openclaw.json");
    const policyPath = path.join(root, "policy.json");
    const backupPath = path.join(root, "backup.json");
    await fs.writeFile(
      configPath,
      `${JSON.stringify({ agents: { entries: { "hicks-orchestrator": {} } }, bindings: [{ agentId: "hicks-orchestrator" }] })}\n`,
    );
    await fs.writeFile(policyPath, `${JSON.stringify(policy)}\n`);
    await expect(
      applyOrchestratorToolPolicy({ configPath, policyPath, backupPath }),
    ).rejects.toThrow(/Telegram binding/);
    await expect(fs.access(backupPath)).rejects.toThrow();
  });
});
