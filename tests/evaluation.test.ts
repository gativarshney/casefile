import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EvaluationReport, evaluate } from "../src/eval/evaluate.js";
import { calibration, classify, prAuc } from "../src/eval/metrics.js";
import { splitByComponent } from "../src/eval/split.js";
import { buildTrainingSet, trainModel } from "../src/eval/train.js";
import { decide, decisionBoundaries, realisedCostMinor } from "../src/verify/policy.js";
import { generateWorld, qualitySpec } from "../src/world/generate/index.js";
import { CARDS, SESSIONS } from "../src/world/schema.js";
import { type DatasetManifest, WorldReader } from "../src/world/store.js";

let directory: string;
let report: EvaluationReport;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "casefile-eval-"));
  const generated = generateWorld({ spec: qualitySpec(), outputDirectory: directory });
  const training = buildTrainingSet(generated.worldPath, generated.labelsPath);
  const { model } = trainModel(training, {
    world: "quality",
    specDigest: "quality",
    alerts: training.rows.length,
    positives: training.rows.filter((row) => row.isFraud).length,
  });
  const manifest = JSON.parse(
    readFileSync(join(directory, "dataset_manifest.json"), "utf8"),
  ) as DatasetManifest;
  report = evaluate(generated.worldPath, generated.labelsPath, manifest, model, "quality");
}, 120_000);

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("classification metrics", () => {
  it("computes a known confusion matrix", () => {
    const metrics = classify([true, true, false, false], [true, false, true, false]);
    expect(metrics.truePositives).toBe(1);
    expect(metrics.falsePositives).toBe(1);
    expect(metrics.falseNegatives).toBe(1);
    expect(metrics.trueNegatives).toBe(1);
    expect(metrics.precision).toBeCloseTo(0.5, 10);
    expect(metrics.recall).toBeCloseTo(0.5, 10);
    expect(metrics.f1).toBeCloseTo(0.5, 10);
  });

  it("reports zero rather than dividing by zero when nothing is predicted", () => {
    const metrics = classify([false, false], [true, false]);
    expect(metrics.precision).toBe(0);
    expect(metrics.f1).toBe(0);
  });

  it("PR-AUC is 1 for a perfect ranking", () => {
    expect(prAuc([0.9, 0.8, 0.2, 0.1], [true, true, false, false])).toBeCloseTo(1, 6);
  });

  it("PR-AUC approaches the base rate for a useless ranking", () => {
    const scores = Array.from({ length: 100 }, (_, i) => i / 100);
    const labels = scores.map((_, i) => i % 4 === 0);
    expect(prAuc(scores, labels)).toBeLessThan(0.45);
  });

  it("a perfectly calibrated forecaster has near-zero error", () => {
    // Each bin holds 100 forecasts at probability p, of which exactly p are positive.
    const probabilities: number[] = [];
    const actual: boolean[] = [];
    for (let bin = 0; bin < 10; bin += 1) {
      const p = bin / 10 + 0.05;
      for (let index = 0; index < 100; index += 1) {
        probabilities.push(p);
        actual.push(index < Math.round(p * 100));
      }
    }
    expect(calibration(probabilities, actual).expectedCalibrationError).toBeLessThan(0.02);
  });

  it("a confidently wrong forecaster has a poor Brier score", () => {
    const probabilities = new Array(100).fill(0.99);
    expect(calibration(probabilities, new Array(100).fill(false)).brier).toBeGreaterThan(0.9);
  });
});

describe("expected-cost policy", () => {
  it("clears when fraud is very unlikely", () => {
    expect(decide(0.001, 100_000).action).toBe("clear");
  });

  it("confirms when fraud is very likely", () => {
    expect(decide(0.99, 100_000).action).toBe("confirm");
  });

  it("escalates in the ambiguous middle", () => {
    expect(decide(0.4, 100_000).action).toBe("escalate");
  });

  it("boundaries are ordered and lie inside the unit interval", () => {
    const { clearBelow, confirmAbove } = decisionBoundaries(100_000);
    expect(clearBelow).toBeGreaterThan(0);
    expect(clearBelow).toBeLessThan(confirmAbove);
    expect(confirmAbove).toBeLessThanOrEqual(1);
  });

  it("larger amounts justify blocking at a lower probability", () => {
    // The loss from letting fraud through scales with value while the goodwill cost of a
    // wrong block does not, so the bar for blocking falls as the amount rises.
    const small = decisionBoundaries(50_000).confirmAbove;
    const large = decisionBoundaries(5_000_000).confirmAbove;
    expect(large).toBeLessThan(small);
  });

  it("a correct block costs nothing and a wrong one does not", () => {
    expect(realisedCostMinor("confirm", true, 100_000)).toBe(0);
    expect(realisedCostMinor("confirm", false, 100_000)).toBeGreaterThan(0);
  });

  it("clearing fraud costs the goods and the fee", () => {
    expect(realisedCostMinor("clear", true, 100_000)).toBeGreaterThan(100_000);
    expect(realisedCostMinor("clear", false, 100_000)).toBe(0);
  });

  it("escalation always costs analyst time", () => {
    expect(realisedCostMinor("escalate", true, 1)).toBeGreaterThan(0);
    expect(realisedCostMinor("escalate", false, 1)).toBeGreaterThan(0);
  });
});

describe("entity-disjoint split", () => {
  it("puts accounts that share a device in the same fold", () => {
    const reader = new WorldReader(join(directory, "world.db"));
    try {
      const folds = splitByComponent(reader);
      const accountsByDevice = new Map<string, Set<string>>();
      for (const session of reader.all(SESSIONS)) {
        if (!session.customerId) continue;
        const set = accountsByDevice.get(session.deviceId) ?? new Set<string>();
        set.add(session.customerId);
        accountsByDevice.set(session.deviceId, set);
      }
      for (const accounts of accountsByDevice.values()) {
        if (accounts.size < 2) continue;
        const assigned = [...accounts].map((id) => folds.get(id));
        expect(new Set(assigned).size, "a shared device spans folds").toBe(1);
      }
    } finally {
      reader.close();
    }
  });

  it("puts accounts sharing a payment instrument in the same fold", () => {
    const reader = new WorldReader(join(directory, "world.db"));
    try {
      const folds = splitByComponent(reader);
      const accountsByInstrument = new Map<string, Set<string>>();
      for (const card of reader.all(CARDS)) {
        const key = `${card.bin}:${card.last4}`;
        const set = accountsByInstrument.get(key) ?? new Set<string>();
        set.add(card.customerId);
        accountsByInstrument.set(key, set);
      }
      for (const accounts of accountsByInstrument.values()) {
        if (accounts.size < 2) continue;
        expect(new Set([...accounts].map((id) => folds.get(id))).size).toBe(1);
      }
    } finally {
      reader.close();
    }
  });

  it("assigns both folds a meaningful share", () => {
    const reader = new WorldReader(join(directory, "world.db"));
    try {
      const folds = [...splitByComponent(reader).values()];
      const calibrate = folds.filter((fold) => fold === "calibrate").length;
      expect(calibrate / folds.length).toBeGreaterThan(0.1);
      expect(calibrate / folds.length).toBeLessThan(0.5);
    } finally {
      reader.close();
    }
  });
});

/**
 * Criteria fixed in advance, on development data, so that "is the problem hard enough"
 * is answered before any held-out number exists. Failing any of these means the
 * generator or the model needs work — never that the thresholds should move.
 */
describe("the evaluation is worth believing", () => {
  it("the alert queue is genuinely noisy", () => {
    expect(report.fraudInAlerts / report.alerts).toBeLessThan(0.4);
  });

  it("naive baselines are weak", () => {
    const byName = new Map(report.baselines.map((baseline) => [baseline.name, baseline]));
    expect(byName.get("amount_threshold")?.metrics.f1 ?? 1).toBeLessThan(0.35);
    expect(byName.get("always_confirm")?.metrics.f1 ?? 1).toBeLessThan(0.6);
    expect(byName.get("always_clear")?.metrics.f1 ?? 1).toBe(0);
  });

  it("casefile beats every baseline on cost", () => {
    for (const baseline of report.baselines) {
      expect(report.costs.casefileMinor, baseline.name).toBeLessThan(baseline.costMinor);
    }
  });

  it("performance is strong without being implausible", () => {
    expect(report.casefile.f1).toBeGreaterThan(0.6);
    expect(report.casefile.f1).toBeLessThan(0.95);
  });

  it("hard negatives dominate the false alerts the verifier has to clear", () => {
    // The queue is only difficult if the legitimate traffic in it genuinely resembles
    // fraud. Decoys earn their name by making up the bulk of what must be cleared.
    const decoyAlerts = report.decoyCohorts.reduce((sum, cohort) => sum + cohort.count, 0);
    const legitimateAlerts = report.alerts - report.fraudInAlerts;
    expect(decoyAlerts).toBeGreaterThan(0);
    expect(decoyAlerts / legitimateAlerts).toBeGreaterThan(0.3);
  });

  it("several distinct hard-negative cohorts are represented", () => {
    expect(report.decoyCohorts.filter((cohort) => cohort.count >= 5).length).toBeGreaterThan(3);
  });

  it("friendly fraud is not claimed to be solved", () => {
    const friendly = report.perFamily.find((cohort) => cohort.name === "friendly_fraud");
    if (!friendly) return;
    expect(friendly.blockRate).toBeLessThan(0.4);
  });

  it("no fraud family is perfectly detected", () => {
    for (const family of report.perFamily) {
      if (family.count < 10) continue;
      expect(family.blockRate, `${family.name} is suspiciously perfect`).toBeLessThan(1);
    }
  });

  it("probabilities are calibrated", () => {
    expect(report.calibration.expectedCalibrationError).toBeLessThan(0.15);
    expect(report.calibration.brier).toBeLessThan(0.15);
  });

  it("most alerts are resolved without an analyst", () => {
    expect(report.autoDecisionRate).toBeGreaterThan(0.5);
  });
});

describe("the headline number cannot overstate the system", () => {
  it("end-to-end block rate accounts for fraud that never reaches the queue", () => {
    const e2e = report.endToEnd;
    expect(e2e.fraudReachingQueue).toBeLessThanOrEqual(e2e.fraudInWorld);
    expect(e2e.fraudBlocked).toBeLessThanOrEqual(e2e.fraudReachingQueue);
    // Triage precision is measured on the queue; end-to-end recall includes everything
    // the alerting layer missed, so it must be the more conservative figure.
    expect(e2e.endToEndBlockRate).toBeLessThanOrEqual(report.casefile.recall + 1e-9);
  });

  it("reports the mechanisms that evade alerting entirely", () => {
    const invisible = report.endToEnd.invisibleToAlerting.filter(
      (cohort) => cohort.count >= 5 && cohort.catchRate < 0.2,
    );
    // Friendly fraud is expected here: nothing distinguishes it at authorisation time.
    expect(invisible.some((cohort) => cohort.name.startsWith("friendly_fraud"))).toBe(true);
  });

  it("every mechanism present in the world is accounted for", () => {
    const total = report.endToEnd.invisibleToAlerting.reduce(
      (sum, cohort) => sum + cohort.count,
      0,
    );
    expect(total).toBe(report.endToEnd.fraudInWorld);
  });
});
