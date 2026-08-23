/**
 * The end-to-end path: generate → alert → investigate → seal → replay → integrity.
 *
 * This exists to prove the architecture holds together before the realistic generator,
 * the fitted scorer and the evaluation harness are built on top of it.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseSync from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { raiseAlerts } from "../src/alerting/rules.js";
import { canonicalJson } from "../src/canon/canonical.js";
import {
  type CaseArtifact,
  caseHashOf,
  investigate,
  readCase,
  writeCase,
} from "../src/case/artifact.js";
import { ReplayMismatchError, replayCase } from "../src/replay/replay.js";
import { generateWorld } from "../src/world/generate.js";
import { TRANSACTIONS } from "../src/world/schema.js";
import { type DatasetManifest, IntegrityError, WorldReader } from "../src/world/store.js";

const SEED = 20_250_106;

let directory: string;
let worldPath: string;
let manifest: DatasetManifest;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "casefile-slice-"));
  const result = generateWorld({ seed: SEED, outputDirectory: directory });
  worldPath = result.worldPath;
  manifest = result.manifest;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function withWorld<T>(run: (reader: WorldReader) => T): T {
  const reader = new WorldReader(worldPath);
  try {
    return run(reader);
  } finally {
    reader.close();
  }
}

/** The alert at the end of the card-testing burst, where the full pattern is visible. */
function burstCase(): CaseArtifact {
  return withWorld((reader) => {
    const alerts = raiseAlerts(reader);
    const alert = alerts[alerts.length - 1];
    if (!alert) throw new Error("the generated world raised no alerts");
    return investigate(reader, manifest, alert);
  });
}

function tamper(sql: string, params: readonly unknown[]): void {
  const db = new DatabaseSync(worldPath);
  db.prepare(sql).run(...(params as never[]));
  db.close();
}

describe("generation is reproducible", () => {
  it("the same seed produces the same world root", () => {
    const other = mkdtempSync(join(tmpdir(), "casefile-repeat-"));
    try {
      const repeat = generateWorld({ seed: SEED, outputDirectory: other });
      expect(repeat.manifest.worldRoot).toBe(manifest.worldRoot);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("a different seed produces a different world root", () => {
    const other = mkdtempSync(join(tmpdir(), "casefile-other-"));
    try {
      const different = generateWorld({ seed: SEED + 1, outputDirectory: other });
      expect(different.manifest.worldRoot).not.toBe(manifest.worldRoot);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("the generated world verifies against its own manifest", () => {
    expect(() => withWorld((r) => r.verifyAgainstManifest(manifest))).not.toThrow();
  });
});

describe("the rules engine raises alerts", () => {
  it("flags the card-testing burst", () => {
    const alerts = withWorld(raiseAlerts);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.some((alert) => alert.txnId.startsWith("txn_f0001"))).toBe(true);
  });

  it("over-alerts rather than under-alerting, which is why triage is needed", () => {
    const alerts = withWorld(raiseAlerts);
    const distinctRules = new Set(alerts.map((alert) => alert.ruleId));
    expect(distinctRules.size).toBeGreaterThan(0);
    expect(alerts.length).toBeGreaterThan(1);
  });
});

describe("investigation", () => {
  it("reaches a confirmed verdict on the burst", () => {
    expect(burstCase().action).toBe("confirm");
  });

  it("every finding cites at least one evidence item", () => {
    for (const finding of burstCase().findings) {
      expect(finding.evidenceIds.length).toBeGreaterThan(0);
    }
  });

  it("every cited evidence id belongs to this case", () => {
    const artifact = burstCase();
    const known = new Set(artifact.evidence.map((item) => item.evidenceId));
    for (const finding of artifact.findings) {
      for (const id of finding.evidenceIds) expect(known).toContain(id);
    }
  });

  it("every evidence item names the source records it was derived from", () => {
    for (const evidence of burstCase().evidence) {
      expect(evidence.sources.length).toBeGreaterThan(0);
      for (const source of evidence.sources) {
        expect(source.hash).toMatch(/^sha256:/);
      }
    }
  });

  it("every cited source record exists in the world", () => {
    const artifact = burstCase();
    withWorld((reader) => {
      for (const evidence of artifact.evidence) {
        for (const source of evidence.sources) {
          const type = reader.recordTypeFor(source.table);
          expect(reader.rawRecord(type, source.id)).toBeDefined();
        }
      }
    });
  });

  it("investigating the same alert twice produces an identical case", () => {
    expect(burstCase()).toEqual(burstCase());
  });

  it("the sealed artifact contains no floating point value", () => {
    // canonicalJson throws on any float, so this asserts the numerical boundary held
    // all the way from probe payloads through scoring into persisted state.
    expect(() => canonicalJson(JSON.parse(JSON.stringify(burstCase())))).not.toThrow();
  });

  it("the score is a fixed-precision string, not a number", () => {
    expect(typeof burstCase().score).toBe("string");
  });
});

describe("replay", () => {
  it("an untouched case replays successfully", () => {
    const artifact = burstCase();
    const result = withWorld((reader) => replayCase(reader, manifest, artifact));
    expect(result.caseHash).toBe(artifact.caseHash);
    expect(result.recordsVerified).toBeGreaterThan(1);
  });

  it("survives a write and read round trip through disk", () => {
    const artifact = burstCase();
    const path = join(directory, "case.json");
    writeCase(path, artifact);
    expect(() => withWorld((reader) => replayCase(reader, manifest, readCase(path)))).not.toThrow();
  });

  it("rejects a case built against a different world", () => {
    const artifact = burstCase();
    const foreign = { ...manifest, worldRoot: "sha256:0000" };
    expect(() => withWorld((reader) => replayCase(reader, foreign, artifact))).toThrow(
      IntegrityError,
    );
  });
});

describe("tamper detection", () => {
  it("a modified source record fails replay", () => {
    const artifact = burstCase();
    const cited = artifact.evidence[0]?.sources.find((s) => s.table === "transactions");
    if (!cited) throw new Error("expected the case to cite a transaction");

    tamper("UPDATE transactions SET amountMinor = ? WHERE txnId = ?", [999_900, cited.id]);

    expect(() => withWorld((reader) => replayCase(reader, manifest, artifact))).toThrow(
      IntegrityError,
    );
  });

  it("the failure names the record, the sealed digest and the actual one", () => {
    const artifact = burstCase();
    const cited = artifact.evidence[0]?.sources.find((s) => s.table === "transactions");
    if (!cited) throw new Error("expected the case to cite a transaction");

    tamper("UPDATE transactions SET amountMinor = ? WHERE txnId = ?", [999_900, cited.id]);

    try {
      withWorld((reader) => replayCase(reader, manifest, artifact));
      expect.unreachable("expected an integrity failure");
    } catch (error) {
      const failure = error as IntegrityError;
      expect(failure.subject).toBe(`transactions:${cited.id}`);
      expect(failure.expected).toBe(cited.hash);
      expect(failure.actual).not.toBe(cited.hash);
    }
  });

  it("a deleted source record fails replay", () => {
    const artifact = burstCase();
    const cited = artifact.evidence[0]?.sources.find((s) => s.table === "cards");
    if (!cited) throw new Error("expected the case to cite a card");

    tamper("DELETE FROM cards WHERE cardId = ?", [cited.id]);

    expect(() => withWorld((reader) => replayCase(reader, manifest, artifact))).toThrow(
      /no longer exists/,
    );
  });

  it("a modified record is caught even when its stored digest is updated to match", () => {
    const artifact = burstCase();
    const cited = artifact.evidence[0]?.sources.find((s) => s.table === "transactions");
    if (!cited) throw new Error("expected the case to cite a transaction");

    const db = new DatabaseSync(worldPath);
    db.prepare("UPDATE transactions SET amountMinor = ?, record_hash = ? WHERE txnId = ?").run(
      999_900,
      "sha256:whatever-the-attacker-likes",
      cited.id,
    );
    db.close();

    expect(() => withWorld((reader) => replayCase(reader, manifest, artifact))).toThrow(
      IntegrityError,
    );
  });

  it("an edited case artifact fails its own hash check", () => {
    const artifact = burstCase();
    const forged = { ...artifact, action: "clear" as const };
    expect(() => withWorld((reader) => replayCase(reader, manifest, forged))).toThrow(
      /does not hash to its own sealed value/,
    );
  });

  it("an artifact with an evidence item removed fails its own hash check", () => {
    const artifact = burstCase();
    const forged = { ...artifact, evidence: artifact.evidence.slice(1) };
    expect(() => withWorld((reader) => replayCase(reader, manifest, forged))).toThrow(
      IntegrityError,
    );
  });

  it("an untouched record elsewhere in the world does not fail replay", () => {
    const artifact = burstCase();
    const citedIds = new Set(artifact.evidence.flatMap((e) => e.sources.map((s) => s.id)));
    const uncited = withWorld((reader) =>
      reader
        .all(TRANSACTIONS)
        .map((txn) => txn.txnId)
        .find((id) => !citedIds.has(id) && id !== artifact.subject.txnId),
    );
    if (!uncited) throw new Error("expected an uncited transaction to exist");

    tamper("UPDATE transactions SET amountMinor = ? WHERE txnId = ?", [123_456, uncited]);

    // Replay verifies what the case actually relied on, not the whole database.
    expect(() => withWorld((reader) => replayCase(reader, manifest, artifact))).not.toThrow();
  });
});

describe("replay distinguishes tampering from system drift", () => {
  it("a diverging verdict on intact data is a mismatch, not an integrity failure", () => {
    const artifact = burstCase();
    const drifted: CaseArtifact = { ...artifact, score: "0.0000", action: "clear" };
    // Re-seal so the artifact passes its own hash check and the divergence is reached.
    const resealed = { ...drifted, caseHash: caseHashOf(drifted) };

    expect(() => withWorld((reader) => replayCase(reader, manifest, resealed))).toThrow(
      ReplayMismatchError,
    );
  });
});

describe("the case artifact is inspectable", () => {
  it("is written as readable JSON a person can follow by hand", () => {
    const artifact = burstCase();
    const path = join(directory, "case.json");
    writeCase(path, artifact);
    const text = readFileSync(path, "utf8");
    expect(text).toContain(artifact.caseId);
    expect(text).toContain("evidenceId");
    expect(JSON.parse(text)).toEqual(artifact);
  });
});
