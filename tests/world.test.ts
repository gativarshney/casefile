import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { raiseAlerts } from "../src/alerting/rules.js";
import { canonicalJson } from "../src/canon/canonical.js";
import { inspectWorld } from "../src/eval/inspect.js";
import { entityId } from "../src/world/generate/ids.js";
import {
  developmentSpec,
  generateWorld,
  heldoutSpec,
  qualitySpec,
  testSpec,
} from "../src/world/generate/index.js";
import { LabelReader, NOVEL_VARIANTS, TRANSACTION_LABELS } from "../src/world/labels.js";
import {
  AUTH_EVENTS,
  CARDS,
  CUSTOMERS,
  DEVICES,
  DISPUTES,
  PROFILE_CHANGES,
  SESSIONS,
  TRANSACTIONS,
} from "../src/world/schema.js";
import { WorldReader } from "../src/world/store.js";

let directory: string;
let worldPath: string;
let labelsPath: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "casefile-world-"));
  const result = generateWorld({ spec: testSpec(), outputDirectory: directory });
  worldPath = result.worldPath;
  labelsPath = result.labelsPath;
});

afterAll(() => {
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

function withLabels<T>(run: (reader: LabelReader) => T): T {
  const reader = new LabelReader(labelsPath);
  try {
    return run(reader);
  } finally {
    reader.close();
  }
}

function generateInto<T>(
  spec: Parameters<typeof generateWorld>[0]["spec"],
  run: (dir: string) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), "casefile-tmp-"));
  try {
    generateWorld({ spec, outputDirectory: dir });
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("determinism", () => {
  it("the same spec reproduces the same world byte for byte", () => {
    expect(generateInto(testSpec(), readRoot)).toBe(generateInto(testSpec(), readRoot));
  });

  it("adding an unrelated actor leaves every existing actor's history untouched", () => {
    // The property path-derived streams exist to guarantee: without it, two worlds
    // differing by one parameter are incomparable and every ablation is confounded.
    //
    // Scoped to the legitimate population. Fraud scenarios select victims from the pool,
    // so growing the pool legitimately changes who gets attacked; that is a property of
    // the simulation, not of the random streams.
    const noFraud = {
      cardTestingBurst: 0,
      cardTestingSlowLow: 0,
      atoCredentialStuffing: 0,
      atoSessionHijack: 0,
      ringSharedInfrastructure: 0,
      ringTimingOnly: 0,
      friendlyBuyersRemorse: 0,
      friendlyFamilyMember: 0,
    };
    const base = testSpec({ fraud: noFraud });
    const larger = testSpec({
      fraud: noFraud,
      archetypes: { ...base.archetypes, casual: base.archetypes.casual + 1 },
    });

    const historyOf = (dir: string): Map<string, string> => {
      const reader = new WorldReader(join(dir, "world.db"));
      try {
        const byCustomer = new Map<string, string[]>();
        for (const txn of reader.all(TRANSACTIONS)) {
          if (!txn.customerId) continue;
          byCustomer.set(txn.customerId, [
            ...(byCustomer.get(txn.customerId) ?? []),
            canonicalJson(txn as unknown as Record<string, unknown>),
          ]);
        }
        return new Map([...byCustomer].map(([id, rows]) => [id, rows.sort().join("|")]));
      } finally {
        reader.close();
      }
    };

    const before = generateInto(base, historyOf);
    const after = generateInto(larger, historyOf);

    let compared = 0;
    for (const [customerId, history] of before) {
      const later = after.get(customerId);
      if (later === undefined) continue;
      expect(later, `history changed for ${customerId}`).toBe(history);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(10);
  });

  it("a different seed produces a different world", () => {
    const a = generateInto(testSpec(), readRoot);
    const b = generateInto(testSpec({ seed: 424_242 }), readRoot);
    expect(a).not.toBe(b);
  });
});

describe("identifiers", () => {
  it("encode nothing about role, family or generation order", () => {
    const prefixes = withWorld(
      (reader) => new Set(reader.all(TRANSACTIONS).map((txn) => txn.txnId.split("_")[0])),
    );
    expect([...prefixes]).toEqual(["txn"]);
  });

  it("are content-derived and stable", () => {
    expect(entityId("d", 1, "customer", "a", 1)).toBe(entityId("d", 1, "customer", "a", 1));
  });

  it("differ across worlds even for the same logical actor", () => {
    expect(entityId("d", 1, "customer", "a")).not.toBe(entityId("h", 1, "customer", "a"));
  });

  it("carry no ordering information", () => {
    const ids = withWorld((reader) => reader.all(CUSTOMERS).map((c) => c.customerId));
    const signups = withWorld(
      (reader) => new Map(reader.all(CUSTOMERS).map((c) => [c.customerId, c.signupAtMs])),
    );
    const sortedById = [...ids].sort();
    const signupOrder = sortedById.map((id) => signups.get(id) as number);
    const ascending = signupOrder.every(
      (value, i) => i === 0 || value >= (signupOrder[i - 1] as number),
    );
    expect(ascending).toBe(false);
  });
});

describe("referential integrity", () => {
  it("every transaction points at records that exist", () => {
    withWorld((reader) => {
      const customers = new Set(reader.all(CUSTOMERS).map((c) => c.customerId));
      const cards = new Set(reader.all(CARDS).map((c) => c.cardId));
      const sessions = new Set(reader.all(SESSIONS).map((s) => s.sessionId));
      for (const txn of reader.all(TRANSACTIONS)) {
        if (txn.customerId !== null) expect(customers).toContain(txn.customerId);
        expect(cards).toContain(txn.cardId);
        expect(sessions).toContain(txn.sessionId);
      }
    });
  });

  it("every session points at a device and an address that exist", () => {
    withWorld((reader) => {
      const devices = new Set(reader.all(DEVICES).map((d) => d.deviceId));
      for (const session of reader.all(SESSIONS)) expect(devices).toContain(session.deviceId);
    });
  });

  it("every declined transaction states a reason and every capture does not", () => {
    withWorld((reader) => {
      for (const txn of reader.all(TRANSACTIONS)) {
        if (txn.status === "declined") expect(txn.declineReason).not.toBeNull();
        if (txn.status === "captured") expect(txn.declineReason).toBeNull();
      }
    });
  });
});

describe("temporal coherence", () => {
  it("no card is used before it was added", () => {
    withWorld((reader) => {
      const added = new Map(reader.all(CARDS).map((c) => [c.cardId, c.addedAtMs]));
      const early = reader
        .all(TRANSACTIONS)
        .filter((txn) => txn.atMs < (added.get(txn.cardId) as number));
      expect(early).toEqual([]);
    });
  });

  it("no authentication event precedes its session", () => {
    withWorld((reader) => {
      const started = new Map(reader.all(SESSIONS).map((s) => [s.sessionId, s.startedAtMs]));
      for (const event of reader.all(AUTH_EVENTS)) {
        expect(event.atMs).toBeGreaterThanOrEqual((started.get(event.sessionId) as number) - 1);
      }
    });
  });

  it("every dispute is opened after the transaction it challenges", () => {
    withWorld((reader) => {
      const times = new Map(reader.all(TRANSACTIONS).map((t) => [t.txnId, t.atMs]));
      for (const dispute of reader.all(DISPUTES)) {
        expect(dispute.openedAtMs).toBeGreaterThan(times.get(dispute.txnId) as number);
      }
    });
  });

  it("profile changes fall inside the session that made them", () => {
    withWorld((reader) => {
      const sessions = new Map(reader.all(SESSIONS).map((s) => [s.sessionId, s]));
      for (const change of reader.all(PROFILE_CHANGES)) {
        expect(sessions.has(change.sessionId)).toBe(true);
      }
    });
  });
});

describe("ground truth is isolated", () => {
  it("the world store cannot see label tables", () => {
    expect(() => withWorld((reader) => reader.count("transaction_labels"))).toThrow();
  });

  it("labels cover every transaction exactly once", () => {
    const txnIds = withWorld((reader) => reader.all(TRANSACTIONS).map((t) => t.txnId));
    const labelled = withLabels((reader) => reader.all(TRANSACTION_LABELS).map((l) => l.txnId));
    expect(new Set(labelled).size).toBe(labelled.length);
    expect(new Set(labelled)).toEqual(new Set(txnIds));
  });
});

describe("held-out design", () => {
  it("development contains neither novel variant", () => {
    const variants = new Set(
      Object.entries(developmentSpec().fraud)
        .filter(([, count]) => count > 0)
        .map(([name]) => name),
    );
    expect(variants.has("cardTestingSlowLow")).toBe(false);
    expect(variants.has("ringTimingOnly")).toBe(false);
  });

  it("the held-out world contains both novel variants", () => {
    expect(heldoutSpec().fraud.cardTestingSlowLow).toBeGreaterThan(0);
    expect(heldoutSpec().fraud.ringTimingOnly).toBeGreaterThan(0);
    expect(NOVEL_VARIANTS).toEqual(["slow_low", "timing_only"]);
  });

  it("the two worlds share no identifier namespace", () => {
    expect(developmentSpec().idNamespace).not.toBe(heldoutSpec().idNamespace);
  });

  it("the held-out window begins after development ends", () => {
    const dev = developmentSpec();
    expect(heldoutSpec().startAtMs).toBeGreaterThan(dev.startAtMs + dev.days * 86_400_000);
  });
});

describe("the world survives its own quality checks", () => {
  it("passes every synthetic-shortcut check at a realistic scale", () => {
    const failed = generateInto(qualitySpec(), (dir) =>
      inspectWorld(join(dir, "world.db"), join(dir, "labels.db"))
        .checks.filter((check) => !check.passed)
        .map((check) => check.name),
    );
    expect(failed).toEqual([]);
  });

  it("contains all four fraud families and a hard-negative cohort", () => {
    const labels = withLabels((reader) => reader.all(TRANSACTION_LABELS));
    expect(new Set(labels.filter((l) => l.isFraud).map((l) => l.family)).size).toBe(4);
    expect(labels.some((l) => l.decoyKind !== null)).toBe(true);
  });
});

describe("the alert stream is a triage problem", () => {
  it("over-alerts: most alerts are not fraud", () => {
    const alerts = withWorld(raiseAlerts);
    const fraud = withLabels(
      (reader) =>
        new Set(
          reader
            .all(TRANSACTION_LABELS)
            .filter((l) => l.isFraud)
            .map((l) => l.txnId),
        ),
    );
    const precision = alerts.filter((a) => fraud.has(a.txnId)).length / alerts.length;
    expect(precision).toBeLessThan(0.5);
    expect(precision).toBeGreaterThan(0.02);
  });

  it("catches most fraud, so triage does not have to compensate for blindness", () => {
    const alerts = new Set(withWorld(raiseAlerts).map((a) => a.txnId));
    const fraud = withLabels((reader) => reader.all(TRANSACTION_LABELS).filter((l) => l.isFraud));
    const recall = fraud.filter((l) => alerts.has(l.txnId)).length / fraud.length;
    expect(recall).toBeGreaterThan(0.5);
  });

  it("surfaces hard negatives for the verifier to clear", () => {
    const alerts = new Set(withWorld(raiseAlerts).map((a) => a.txnId));
    const decoyAlerts = withLabels((reader) =>
      reader
        .all(TRANSACTION_LABELS)
        .filter((l) => !l.isFraud && l.decoyKind !== null && alerts.has(l.txnId)),
    );
    expect(decoyAlerts.length).toBeGreaterThan(0);
  });

  it("barely sees friendly fraud, because nothing distinguishes it at authorisation", () => {
    const alerts = new Set(withWorld(raiseAlerts).map((a) => a.txnId));
    const friendly = withLabels((reader) =>
      reader.all(TRANSACTION_LABELS).filter((l) => l.family === "friendly_fraud"),
    );
    const recall = friendly.filter((l) => alerts.has(l.txnId)).length / friendly.length;
    expect(recall).toBeLessThan(0.5);
  });
});

function readRoot(dir: string): string {
  return (
    JSON.parse(readFileSync(join(dir, "dataset_manifest.json"), "utf8")) as { worldRoot: string }
  ).worldRoot;
}
