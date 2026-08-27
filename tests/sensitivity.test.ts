import { describe, expect, it } from "vitest";
import type { ScoredAlert } from "../src/eval/evaluate.js";
import {
  analyseSensitivity,
  outcomeCosts,
  priceUnder,
  sensitivityAxes,
} from "../src/eval/sensitivity.js";
import { type CostModel, DEFAULT_COSTS, realisedCostMinor } from "../src/verify/policy.js";

const COSTS: CostModel = {
  chargebackFeeMinor: 100_000,
  lossGivenFraudBps: 10_000,
  marginBps: 1_000,
  falseDeclineGoodwillMinor: 50_000,
  analystReviewMinor: 10_000,
  analystAccuracyBps: 9_000,
};

const AMOUNT = 100_000;
const FRAUD_LOSS = 200_000;
const GENUINE_VALUE = 60_000;

function alert(probability: number, isFraud: boolean, amountMinor = AMOUNT): ScoredAlert {
  return {
    txnId: `txn_${probability}_${isFraud}_${amountMinor}`,
    amountMinor,
    probability,
    action: "escalate",
    isFraud,
    family: null,
    variant: null,
    decoyKind: null,
    archetype: null,
  };
}

describe("outcome costs are read out of the policy", () => {
  it("recovers the false-positive and false-negative cost at a reference amount", () => {
    const { falsePositiveMinor, falseNegativeMinor } = outcomeCosts(COSTS, AMOUNT);
    expect(falsePositiveMinor).toBe(GENUINE_VALUE);
    expect(falseNegativeMinor).toBe(FRAUD_LOSS);
  });

  it("reports an infinite ratio when fraud costs nothing", () => {
    const free: CostModel = { ...COSTS, lossGivenFraudBps: 0, chargebackFeeMinor: 0 };
    expect(outcomeCosts(free, AMOUNT).ratio).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("pricing", () => {
  it("computes hand-checkable costs for a confidently decided pair", () => {
    const outcome = priceUnder([alert(1, true), alert(0, false)], COSTS);

    expect(outcome.confirmed).toBe(1);
    expect(outcome.cleared).toBe(1);
    expect(outcome.casefileMinor).toBe(0);
    // escalate = review + errorRate x outcome cost, at a 10% error rate
    expect(outcome.rulesOnlyMinor).toBe(10_000 + 20_000 + (10_000 + 6_000));
    expect(outcome.clearAllMinor).toBe(FRAUD_LOSS);
    expect(outcome.savedVsRulesMinor).toBe(46_000);
    expect(outcome.savedShare).toBe(1);
    expect(outcome.casefileWins).toBe(true);
  });

  it("reports a loss honestly when the score points the wrong way", () => {
    const outcome = priceUnder([alert(0, true)], COSTS);

    expect(outcome.cleared).toBe(1);
    expect(outcome.casefileMinor).toBe(FRAUD_LOSS);
    expect(outcome.rulesOnlyMinor).toBe(10_000 + 20_000);
    expect(outcome.casefileWins).toBe(false);
    expect(outcome.savedVsRulesMinor).toBeLessThan(0);
  });

  it("agrees with the policy's own realised cost for every row", () => {
    const rows = [alert(1, true), alert(0, false), alert(0.5, true, 250_000)];
    const expected = rows.reduce(
      (sum, row) => sum + realisedCostMinor("clear", row.isFraud, row.amountMinor, COSTS),
      0,
    );
    expect(priceUnder(rows, COSTS).clearAllMinor).toBe(Math.round(expected));
  });

  it("prices an empty queue without dividing by zero", () => {
    const outcome = priceUnder([], COSTS);
    expect(outcome.rulesOnlyMinor).toBe(0);
    expect(outcome.savedShare).toBe(0);
    expect(outcome.casefileWins).toBe(false);
  });
});

describe("boundary values", () => {
  it("charges manual review only its own time when the analyst is never wrong", () => {
    const rows = [alert(0.9, true), alert(0.1, false), alert(0.5, true)];
    const perfect: CostModel = { ...COSTS, analystAccuracyBps: 10_000 };
    expect(priceUnder(rows, perfect).rulesOnlyMinor).toBe(rows.length * COSTS.analystReviewMinor);
  });

  it("charges manual review the full outcome when the analyst is never right", () => {
    const rows = [alert(0.9, true), alert(0.1, false)];
    const useless: CostModel = { ...COSTS, analystAccuracyBps: 0 };
    expect(priceUnder(rows, useless).rulesOnlyMinor).toBe(
      2 * COSTS.analystReviewMinor + FRAUD_LOSS + GENUINE_VALUE,
    );
  });
});

describe("monotonicity that must hold mathematically", () => {
  const rows = [
    alert(0.95, true),
    alert(0.05, false),
    alert(0.4, true, 400_000),
    alert(0.6, false),
  ];

  it("manual review gets cheaper as the analyst gets more accurate", () => {
    const costs = [6_000, 7_000, 8_000, 9_000, 10_000].map(
      (analystAccuracyBps) => priceUnder(rows, { ...COSTS, analystAccuracyBps }).rulesOnlyMinor,
    );
    for (let i = 1; i < costs.length; i += 1) {
      expect(costs[i] as number).toBeLessThan(costs[i - 1] as number);
    }
  });

  it("manual review gets dearer as a false decline costs more", () => {
    const costs = [0, 50_000, 100_000, 200_000].map(
      (falseDeclineGoodwillMinor) =>
        priceUnder(rows, { ...COSTS, falseDeclineGoodwillMinor }).rulesOnlyMinor,
    );
    for (let i = 1; i < costs.length; i += 1) {
      expect(costs[i] as number).toBeGreaterThan(costs[i - 1] as number);
    }
  });

  it("manual review gets dearer as a missed fraud costs more", () => {
    const costs = [0, 75_000, 150_000, 300_000].map(
      (chargebackFeeMinor) => priceUnder(rows, { ...COSTS, chargebackFeeMinor }).rulesOnlyMinor,
    );
    for (let i = 1; i < costs.length; i += 1) {
      expect(costs[i] as number).toBeGreaterThan(costs[i - 1] as number);
    }
  });

  it("clearing everything is unaffected by analyst accuracy", () => {
    const low = priceUnder(rows, { ...COSTS, analystAccuracyBps: 100 }).clearAllMinor;
    const high = priceUnder(rows, { ...COSTS, analystAccuracyBps: 9_900 }).clearAllMinor;
    expect(low).toBe(high);
  });
});

describe("the sweep", () => {
  const rows = [
    alert(0.98, true),
    alert(0.02, false),
    alert(0.75, true, 500_000),
    alert(0.3, false, 250_000),
    alert(0.55, true),
  ];

  it("sweeps the three documented axes around the shipped defaults", () => {
    const axes = sensitivityAxes();
    expect(axes.map((axis) => axis.id)).toEqual([
      "analyst_accuracy",
      "false_decline_goodwill",
      "chargeback_fee",
    ]);
    for (const axis of axes) {
      expect(axis.points.length).toBeGreaterThan(2);
      for (const point of axis.points) {
        // exactly one parameter may move per axis point
        const differing = (Object.keys(DEFAULT_COSTS) as (keyof CostModel)[]).filter(
          (key) => point.costs[key] !== DEFAULT_COSTS[key],
        );
        expect(differing.length).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is deterministic", () => {
    expect(analyseSensitivity(rows)).toEqual(analyseSensitivity(rows));
  });

  it("covers the whole grid and accounts for every combination", () => {
    const report = analyseSensitivity(rows);
    expect(report.grid.combinations).toBe(6 * 5 * 4);
    expect(report.grid.wins + report.grid.losses.length).toBe(report.grid.combinations);
    expect(report.grid.worstSavedShare).toBeLessThanOrEqual(report.grid.bestSavedShare);
  });

  it("reports the shipped defaults unchanged as its reference point", () => {
    const report = analyseSensitivity(rows);
    expect(report.base).toEqual(DEFAULT_COSTS);
    expect(report.baseOutcome).toEqual(priceUnder(rows, DEFAULT_COSTS));
    expect(report.alerts).toBe(rows.length);
  });
});
