import { type CostModel, DEFAULT_COSTS, decide, realisedCostMinor } from "../verify/policy.js";
import type { ScoredAlert } from "./evaluate.js";

export const REFERENCE_AMOUNT_MINOR = 100_000;

export interface CostOutcome {
  readonly casefileMinor: number;
  readonly rulesOnlyMinor: number;
  readonly clearAllMinor: number;
  readonly savedVsRulesMinor: number;
  readonly savedShare: number;
  readonly casefileWins: boolean;
  readonly confirmed: number;
  readonly escalated: number;
  readonly cleared: number;
}

/**
 * Cost of an outcome pair read back out of the policy itself rather than recomputed here.
 * At p=0 the only cost of confirming is a wrongly blocked genuine payment, and at p=1 the
 * only cost of clearing is the fraud getting through, so these are the false-positive and
 * false-negative costs without restating the policy's formulas.
 */
export function outcomeCosts(
  costs: CostModel,
  amountMinor: number = REFERENCE_AMOUNT_MINOR,
): { falsePositiveMinor: number; falseNegativeMinor: number; ratio: number } {
  const falsePositiveMinor = decide(0, amountMinor, costs).alternatives.confirm;
  const falseNegativeMinor = decide(1, amountMinor, costs).alternatives.clear;
  return {
    falsePositiveMinor,
    falseNegativeMinor,
    ratio:
      falseNegativeMinor === 0 ? Number.POSITIVE_INFINITY : falsePositiveMinor / falseNegativeMinor,
  };
}

/**
 * Re-decides every alert under a different view of the trade-off and prices the result.
 *
 * Calibrated probabilities come from the frozen model and do not move; only the policy
 * layer is re-run, which is what the system would actually do if the business changed
 * its cost assumptions.
 */
export function priceUnder(scored: readonly ScoredAlert[], costs: CostModel): CostOutcome {
  let casefileMinor = 0;
  let rulesOnlyMinor = 0;
  let clearAllMinor = 0;
  let confirmed = 0;
  let escalated = 0;
  let cleared = 0;

  for (const row of scored) {
    const action = decide(row.probability, row.amountMinor, costs).action;
    casefileMinor += realisedCostMinor(action, row.isFraud, row.amountMinor, costs);
    rulesOnlyMinor += realisedCostMinor("escalate", row.isFraud, row.amountMinor, costs);
    clearAllMinor += realisedCostMinor("clear", row.isFraud, row.amountMinor, costs);
    if (action === "confirm") confirmed += 1;
    else if (action === "escalate") escalated += 1;
    else cleared += 1;
  }

  casefileMinor = Math.round(casefileMinor);
  rulesOnlyMinor = Math.round(rulesOnlyMinor);
  clearAllMinor = Math.round(clearAllMinor);
  const savedVsRulesMinor = rulesOnlyMinor - casefileMinor;

  return {
    casefileMinor,
    rulesOnlyMinor,
    clearAllMinor,
    savedVsRulesMinor,
    savedShare: rulesOnlyMinor === 0 ? 0 : savedVsRulesMinor / rulesOnlyMinor,
    casefileWins: casefileMinor < rulesOnlyMinor,
    confirmed,
    escalated,
    cleared,
  };
}

/**
 * Sweep ranges are assumptions, not Razorpay figures.
 *
 * Each range is deliberately widened past the point where the default looks good: analyst
 * accuracy drops to barely better than a coin flip on a skewed queue, goodwill damage
 * falls to zero so a false decline costs only forgone margin, and the chargeback fee falls
 * to zero so fraud costs only the goods. If the conclusion depends on a favourable corner,
 * these ranges are where it shows.
 */
export interface AxisPoint {
  readonly label: string;
  readonly costs: CostModel;
}

export interface SensitivityAxis {
  readonly id: string;
  readonly label: string;
  readonly baseLabel: string;
  readonly points: readonly AxisPoint[];
}

const ANALYST_ACCURACY_BPS = [6_000, 7_000, 8_000, 8_500, 9_000, 9_500] as const;
const FALSE_DECLINE_GOODWILL_MINOR = [0, 45_000, 90_000, 180_000, 300_000] as const;
const CHARGEBACK_FEE_MINOR = [0, 75_000, 150_000, 300_000] as const;

const bps = (value: number): string => `${(value / 100).toFixed(0)}%`;
const rupeesLabel = (minor: number): string =>
  `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;

export function sensitivityAxes(base: CostModel = DEFAULT_COSTS): SensitivityAxis[] {
  return [
    {
      id: "analyst_accuracy",
      label: "analyst accuracy",
      baseLabel: bps(base.analystAccuracyBps),
      points: ANALYST_ACCURACY_BPS.map((value) => ({
        label: bps(value),
        costs: { ...base, analystAccuracyBps: value },
      })),
    },
    {
      id: "false_decline_goodwill",
      label: "false-decline goodwill (false-positive cost)",
      baseLabel: rupeesLabel(base.falseDeclineGoodwillMinor),
      points: FALSE_DECLINE_GOODWILL_MINOR.map((value) => ({
        label: rupeesLabel(value),
        costs: { ...base, falseDeclineGoodwillMinor: value },
      })),
    },
    {
      id: "chargeback_fee",
      label: "chargeback fee (false-negative cost)",
      baseLabel: rupeesLabel(base.chargebackFeeMinor),
      points: CHARGEBACK_FEE_MINOR.map((value) => ({
        label: rupeesLabel(value),
        costs: { ...base, chargebackFeeMinor: value },
      })),
    },
  ];
}

export interface AxisRow {
  readonly label: string;
  readonly outcome: CostOutcome;
  readonly falsePositiveToNegative: number;
}

export interface GridEntry {
  readonly analystAccuracyBps: number;
  readonly falseDeclineGoodwillMinor: number;
  readonly chargebackFeeMinor: number;
  readonly outcome: CostOutcome;
}

export interface SensitivityReport {
  readonly base: CostModel;
  readonly referenceAmountMinor: number;
  readonly alerts: number;
  readonly baseOutcome: CostOutcome;
  readonly axes: readonly { id: string; label: string; baseLabel: string; rows: AxisRow[] }[];
  readonly grid: {
    readonly combinations: number;
    readonly wins: number;
    readonly losses: readonly GridEntry[];
    readonly worstSavedShare: number;
    readonly bestSavedShare: number;
  };
}

export function analyseSensitivity(
  scored: readonly ScoredAlert[],
  base: CostModel = DEFAULT_COSTS,
): SensitivityReport {
  const axes = sensitivityAxes(base).map((axis) => ({
    id: axis.id,
    label: axis.label,
    baseLabel: axis.baseLabel,
    rows: axis.points.map((point) => ({
      label: point.label,
      outcome: priceUnder(scored, point.costs),
      falsePositiveToNegative: outcomeCosts(point.costs).ratio,
    })),
  }));

  const losses: GridEntry[] = [];
  let combinations = 0;
  let wins = 0;
  let worstSavedShare = Number.POSITIVE_INFINITY;
  let bestSavedShare = Number.NEGATIVE_INFINITY;

  for (const analystAccuracyBps of ANALYST_ACCURACY_BPS) {
    for (const falseDeclineGoodwillMinor of FALSE_DECLINE_GOODWILL_MINOR) {
      for (const chargebackFeeMinor of CHARGEBACK_FEE_MINOR) {
        const costs: CostModel = {
          ...base,
          analystAccuracyBps,
          falseDeclineGoodwillMinor,
          chargebackFeeMinor,
        };
        const outcome = priceUnder(scored, costs);
        combinations += 1;
        if (outcome.casefileWins) wins += 1;
        else
          losses.push({
            analystAccuracyBps,
            falseDeclineGoodwillMinor,
            chargebackFeeMinor,
            outcome,
          });
        worstSavedShare = Math.min(worstSavedShare, outcome.savedShare);
        bestSavedShare = Math.max(bestSavedShare, outcome.savedShare);
      }
    }
  }

  return {
    base,
    referenceAmountMinor: REFERENCE_AMOUNT_MINOR,
    alerts: scored.length,
    baseOutcome: priceUnder(scored, base),
    axes,
    grid: { combinations, wins, losses, worstSavedShare, bestSavedShare },
  };
}
