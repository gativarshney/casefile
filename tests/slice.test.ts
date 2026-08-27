import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseSync from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Alert, raiseAlerts } from "../src/alerting/rules.js";
import { canonicalJson } from "../src/canon/canonical.js";
import {
  type CaseArtifact,
  caseHashOf,
  investigate,
  readCase,
  writeCase,
} from "../src/case/artifact.js";
import { buildTrainingSet, trainModel } from "../src/eval/train.js";
import { ReplayMismatchError, replayCase } from "../src/replay/replay.js";
import type { FrozenModel } from "../src/scoring/model.js";
import { generateWorld, testSpec } from "../src/world/generate/index.js";
import { LabelReader, TRANSACTION_LABELS } from "../src/world/labels.js";
import { TRANSACTIONS } from "../src/world/schema.js";
import { type DatasetManifest, IntegrityError, WorldReader } from "../src/world/store.js";

let directory: string;
let worldPath: string;
let labelsPath: string;
let manifest: DatasetManifest;
let model: FrozenModel;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "casefile-slice-"));
  const result = generateWorld({ spec: testSpec(), outputDirectory: directory });
  worldPath = result.worldPath;
  labelsPath = result.labelsPath;
  manifest = result.manifest;
  model = trainModel(buildTrainingSet(worldPath, labelsPath), {
    world: "test",
    specDigest: "test",
    alerts: 0,
    positives: 0,
  }).model;
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

function fraudAlert(): Alert {
  const labels = new LabelReader(labelsPath);
  const fraudTxnIds = new Set(
    labels
      .query(TRANSACTION_LABELS, "isFraud = 1 AND family = 'card_testing'")
      .map((row) => row.txnId),
  );
  labels.close();

  const alerts = withWorld(raiseAlerts);
  const alert = alerts.find((candidate) => fraudTxnIds.has(candidate.txnId));
  if (!alert) throw new Error("no card-testing fraud alert in the test world");
  return alert;
}

function fraudCase(): CaseArtifact {
  return withWorld((reader) => investigate(reader, manifest, fraudAlert(), model));
}

function tamper(sql: string, params: readonly unknown[]): void {
  const db = new DatabaseSync(worldPath);
  db.prepare(sql).run(...(params as never[]));
  db.close();
}

describe("generation is reproducible", () => {
  it("the same spec produces the same world root", () => {
    const other = mkdtempSync(join(tmpdir(), "casefile-repeat-"));
    try {
      const repeat = generateWorld({ spec: testSpec(), outputDirectory: other });
      expect(repeat.manifest.worldRoot).toBe(manifest.worldRoot);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("a different seed produces a different world root", () => {
    const other = mkdtempSync(join(tmpdir(), "casefile-other-"));
    try {
      const different = generateWorld({ spec: testSpec({ seed: 99 }), outputDirectory: other });
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
  it("produces a stream of alerts to triage", () => {
    expect(withWorld(raiseAlerts).length).toBeGreaterThan(1);
  });

  it("flags at least one genuine card-testing transaction", () => {
    expect(() => fraudAlert()).not.toThrow();
  });
});

describe("investigation", () => {
  it("reaches a decision and explains it", () => {
    // The specific verdict on a fifty-customer world is not meaningful; that the
    // pipeline produces a decision backed by cited findings is.
    const artifact = fraudCase();
    expect(["confirm", "escalate", "clear"]).toContain(artifact.action);
    expect(artifact.findings.length).toBeGreaterThan(0);
    expect(artifact.evidence.length).toBeGreaterThan(0);
  });

  it("every finding cites at least one evidence item", () => {
    for (const finding of fraudCase().findings) {
      expect(finding.evidenceIds.length).toBeGreaterThan(0);
    }
  });

  it("every cited evidence id belongs to this case", () => {
    const artifact = fraudCase();
    const known = new Set(artifact.evidence.map((item) => item.evidenceId));
    for (const finding of artifact.findings) {
      for (const id of finding.evidenceIds) expect(known).toContain(id);
    }
  });

  it("every evidence item names the source records it was derived from", () => {
    for (const evidence of fraudCase().evidence) {
      expect(evidence.sources.length).toBeGreaterThan(0);
      for (const source of evidence.sources) expect(source.hash).toMatch(/^sha256:/);
    }
  });

  it("investigating the same alert twice produces an identical case", () => {
    const first = fraudCase();
    const second = withWorld((reader) => investigate(reader, manifest, first.alert, model));
    expect(first).toEqual(second);
  });

  it("the sealed artifact contains no floating point value", () => {
    expect(() => canonicalJson(JSON.parse(JSON.stringify(fraudCase())))).not.toThrow();
  });

  it("the probability is a fixed-precision string, not a number", () => {
    expect(typeof fraudCase().fraudProbability).toBe("string");
  });

  it("every contribution names a feature the model knows", () => {
    const artifact = fraudCase();
    for (const contribution of artifact.contributions) {
      expect(model.featureNames).toContain(contribution.feature);
    }
  });

  it("contributions reconstruct the sealed log-odds", () => {
    // The explanation is exact arithmetic, not an approximation: a reviewer can add the
    // contributions to the intercept and arrive at the number the system used.
    const artifact = fraudCase();
    const total =
      Number(model.intercept) +
      artifact.contributions.reduce((sum, contribution) => sum + Number(contribution.logOdds), 0);
    expect(total).toBeCloseTo(Number(artifact.logOdds), 5);
  });
});

describe("replay", () => {
  it("an untouched case replays successfully", () => {
    const artifact = fraudCase();
    const result = withWorld((reader) => replayCase(reader, manifest, artifact, model));
    expect(result.caseHash).toBe(artifact.caseHash);
    expect(result.recordsVerified).toBeGreaterThan(1);
  });

  it("survives a write and read round trip through disk", () => {
    const artifact = fraudCase();
    const path = join(directory, "case.json");
    writeCase(path, artifact);
    expect(() =>
      withWorld((reader) => replayCase(reader, manifest, readCase(path), model)),
    ).not.toThrow();
  });

  it("rejects a case built against a different world", () => {
    const artifact = fraudCase();
    const foreign = { ...manifest, worldRoot: "sha256:0000" };
    expect(() => withWorld((reader) => replayCase(reader, foreign, artifact, model))).toThrow(
      IntegrityError,
    );
  });
});

describe("tamper detection", () => {
  function citedTransaction(artifact: CaseArtifact): { id: string; hash: string } {
    const cited = artifact.evidence
      .flatMap((evidence) => evidence.sources)
      .find((source) => source.table === "transactions");
    if (!cited) throw new Error("expected the case to cite a transaction");
    return cited;
  }

  it("a modified source record fails replay", () => {
    const artifact = fraudCase();
    tamper("UPDATE transactions SET amountMinor = ? WHERE txnId = ?", [
      999_900,
      citedTransaction(artifact).id,
    ]);
    expect(() => withWorld((reader) => replayCase(reader, manifest, artifact, model))).toThrow(
      IntegrityError,
    );
  });

  it("the failure names the record, the sealed digest and the actual one", () => {
    const artifact = fraudCase();
    const cited = citedTransaction(artifact);
    tamper("UPDATE transactions SET amountMinor = ? WHERE txnId = ?", [999_900, cited.id]);
    try {
      withWorld((reader) => replayCase(reader, manifest, artifact, model));
      expect.unreachable("expected an integrity failure");
    } catch (error) {
      const failure = error as IntegrityError;
      expect(failure.subject).toBe(`transactions:${cited.id}`);
      expect(failure.expected).toBe(cited.hash);
      expect(failure.actual).not.toBe(cited.hash);
    }
  });

  it("a record modified with its stored digest updated to match is still caught", () => {
    const artifact = fraudCase();
    const cited = citedTransaction(artifact);
    const db = new DatabaseSync(worldPath);
    db.prepare("UPDATE transactions SET amountMinor = ?, record_hash = ? WHERE txnId = ?").run(
      999_900,
      "sha256:whatever-the-attacker-likes",
      cited.id,
    );
    db.close();
    expect(() => withWorld((reader) => replayCase(reader, manifest, artifact, model))).toThrow(
      IntegrityError,
    );
  });

  it("an edited case artifact fails its own hash check", () => {
    const artifact = fraudCase();
    const forged = {
      ...artifact,
      action: (artifact.action === "clear" ? "confirm" : "clear") as typeof artifact.action,
    };
    expect(() => withWorld((reader) => replayCase(reader, manifest, forged, model))).toThrow(
      /does not hash to its own sealed value/,
    );
  });

  it("an untouched record elsewhere in the world does not fail replay", () => {
    const artifact = fraudCase();
    const citedIds = new Set(artifact.evidence.flatMap((e) => e.sources.map((s) => s.id)));
    const uncited = withWorld((reader) =>
      reader
        .all(TRANSACTIONS)
        .map((txn) => txn.txnId)
        .find((id) => !citedIds.has(id) && id !== artifact.subject.txnId),
    );
    if (!uncited) throw new Error("expected an uncited transaction to exist");
    tamper("UPDATE transactions SET amountMinor = ? WHERE txnId = ?", [123_456, uncited]);
    expect(() =>
      withWorld((reader) => replayCase(reader, manifest, artifact, model)),
    ).not.toThrow();
  });
});

describe("replay distinguishes tampering from system drift", () => {
  it("a diverging verdict on intact data is a mismatch, not an integrity failure", () => {
    const artifact = fraudCase();
    const drifted: CaseArtifact = { ...artifact, fraudProbability: "0.000000", action: "clear" };
    const resealed = { ...drifted, caseHash: caseHashOf(drifted) };
    expect(() => withWorld((reader) => replayCase(reader, manifest, resealed, model))).toThrow(
      ReplayMismatchError,
    );
  });
});

describe("the case artifact is inspectable", () => {
  it("is written as readable JSON a person can follow by hand", () => {
    const artifact = fraudCase();
    const path = join(directory, "case.json");
    writeCase(path, artifact);
    const text = readFileSync(path, "utf8");
    expect(text).toContain(artifact.caseId);
    expect(text).toContain("evidenceId");
    expect(JSON.parse(text)).toEqual(artifact);
  });
});
