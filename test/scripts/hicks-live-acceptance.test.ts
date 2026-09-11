import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  actualGuestEvidence,
  pollWorkboard,
  runHicksLiveAcceptance,
  sha256,
  validateNoFakeProgress,
  validateParallelEvidence,
  writeJsonArtifact,
} from "../../scripts/hicks-live-acceptance.mjs";

async function tempProofDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "hicks-live-acceptance-"));
}

function cards(nonce: string) {
  return {
    cards: [
      {
        id: "parent-1",
        status: "done",
        completedAt: 1_000,
        notes: nonce,
        metadata: {
          automation: { createdCardIds: ["child-1", "child-2"] },
          proof: [{ createdAt: 900, label: "tool evidence" }],
        },
      },
      {
        id: "child-1",
        status: "done",
        runId: "run-1",
        execution: { sessionKey: "agent:luna:one", startedAt: 100, updatedAt: 800 },
        metadata: { attempts: [{ startedAt: 100, endedAt: 800 }] },
      },
      {
        id: "child-2",
        status: "done",
        runId: "run-2",
        execution: { sessionKey: "agent:luna:two", startedAt: 200, updatedAt: 900 },
        metadata: { attempts: [{ startedAt: 200, endedAt: 900 }] },
      },
    ],
  };
}

describe("Hicks post-deploy live acceptance", () => {
  it("rejects caller booleans when independent Telegram evidence is absent", () => {
    expect(() =>
      validateParallelEvidence(
        cards("HICKS_LIVE_nonce"),
        { nonce: "HICKS_LIVE_nonce", sentMessageId: "sent-1", finalDeliveryCount: 1 },
        "HICKS_LIVE_nonce",
      ),
    ).toThrow(/incomplete|independently observed/iu);
  });

  it("accepts only actual overlapping workers and one observed Front delivery", () => {
    expect(
      validateParallelEvidence(
        cards("HICKS_LIVE_nonce"),
        {
          nonce: "HICKS_LIVE_nonce",
          sentMessageId: "sent-1",
          finalDeliveries: [
            { messageId: "final-1", textHash: "a".repeat(64), observedAtMs: 1_100 },
          ],
        },
        "HICKS_LIVE_nonce",
      ),
    ).toMatchObject({
      status: "passed",
      frontAdmissionId: "parent-1",
      workerIds: ["child-1", "child-2"],
      overlapObserved: true,
      parentReconciled: true,
    });
  });

  it("rejects a final state with no timestamped tool/workboard evidence", () => {
    expect(() =>
      validateNoFakeProgress(
        {
          cards: [{ id: "parent-1", status: "done", completedAt: 100, notes: "nonce" }],
        },
        { finalDeliveries: [] },
        "nonce",
      ),
    ).toThrow(/timestamped/iu);
  });

  it("accepts no-fake progress only when evidence precedes one observed Front final", () => {
    expect(
      validateNoFakeProgress(
        cards("HICKS_LIVE_nonce"),
        {
          finalDeliveries: [
            { messageId: "final-1", textHash: "a".repeat(64), observedAtMs: 1_100 },
          ],
        },
        "HICKS_LIVE_nonce",
      ),
    ).toEqual({
      status: "passed",
      toolEvidenceOccurred: true,
      toolEvidenceAtMs: 900,
      finalAtMs: 1_100,
      unsupportedSuccess: false,
    });
  });

  it("accepts Guest only from the harness correlation object", () => {
    expect(
      actualGuestEvidence({
        completed: true,
        guestProof: {
          status: "passed",
          orderedChain: true,
          correlation: {
            updateId: 7,
            providerSeq: 1,
            answerOrdinal: 3,
            outboundMessageId: 99,
            guestQueryHash: "a".repeat(24),
          },
        },
      }),
    ).toMatchObject({
      status: "passed",
      telegramUpdateId: 7,
      answerGuestQuery: true,
      telegramMessageId: 99,
    });
    expect(() =>
      actualGuestEvidence({
        completed: true,
        events: [{ kind: "message", isSut: true, messageId: 99 }],
      }),
    ).toThrow(/correlated/iu);
  });

  it("polls until the real Workboard terminal state appears", async () => {
    let calls = 0;
    let clock = 0;
    const result = await pollWorkboard(
      async () => ({ cards: [{ status: calls++ > 0 ? "done" : "running" }] }),
      (payload) => payload.cards[0]?.status === "done",
      {
        timeoutMs: 10,
        intervalMs: 1,
        now: () => clock,
        delay: async (ms) => {
          clock += ms;
        },
      },
    );
    expect(result.cards[0]?.status).toBe("done");
    expect(calls).toBe(2);
  });

  it("fails closed when deployed runtime, Gateway, Workboard, or Telegram doctor is absent", async () => {
    const proofDir = await tempProofDir();
    const execute = async (
      _command: string,
      args: string[],
      options?: { maxOutputBytes?: number },
    ) => {
      if (args.includes("workboard.cards.list")) {
        expect(options?.maxOutputBytes).toBe(4 * 1024 * 1024);
      }
      return { status: 1, stdout: "", stderr: "missing" };
    };
    const result = await runHicksLiveAcceptance(
      {
        installRoot: path.join(proofDir, "missing-install"),
        proofDir,
        nonce: "HICKS_LIVE_missing",
      },
      { execute },
    );
    expect(result.status).toBe("blocked");
    expect(result.completed).toBe(false);
    expect(result.preflight.reasons.join(" ")).toMatch(/runtime|Gateway|Telegram/iu);
    await expect(
      fs.access(path.join(proofDir, "hicks-live-acceptance.json")),
    ).resolves.toBeUndefined();
    const stored = await fs.readFile(path.join(proofDir, "hicks-live-acceptance.json"), "utf8");
    expect(
      await fs.readFile(path.join(proofDir, "hicks-live-acceptance.json.sha256"), "utf8"),
    ).toContain(sha256(stored));
  });

  it("writes bounded redacted JSON plus a matching digest", async () => {
    const proofDir = await tempProofDir();
    const artifact = await writeJsonArtifact(
      proofDir,
      "evidence.json",
      { token: "do-not-store", sessionKey: "agent:luna:one" },
      ["do-not-store"],
    );
    expect(artifact.sha256).toBe(
      sha256(await fs.readFile(path.join(proofDir, "evidence.json"), "utf8")),
    );
    expect(await fs.readFile(path.join(proofDir, "evidence.json"), "utf8")).not.toContain(
      "do-not-store",
    );
    expect(await fs.readFile(path.join(proofDir, "evidence.json"), "utf8")).toContain(
      "agent:luna:one",
    );
  });
});
