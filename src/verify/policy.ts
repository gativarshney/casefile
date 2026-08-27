export type Action = "confirm" | "escalate" | "clear";

/**
 * What each outcome costs, in rupees.
 *
 * A threshold picked to make a metric look good is not a decision rule. These figures
 * make the trade-off explicit and let the cut-offs be *derived* rather than chosen: the
 * system takes whichever action has the lowest expected cost at the calibrated
 * probability, so changing the business's view of the trade-off changes the behaviour
 * without touching the model.
 *
 * Order-of-magnitude estimates for Indian card-not-present commerce, stated so a reader
 * can disagree with the numbers rather than the method.
 */
export interface CostModel {
  /** Scheme fee and handling for a chargeback that gets through. */
  readonly chargebackFeeMinor: number;
  /** Share of the transaction value irrecoverably lost on confirmed fraud, in bps. */
  readonly lossGivenFraudBps: number;
  /** Merchant margin forgone when a genuine payment is blocked, in bps of value. */
  readonly marginBps: number;
  /** Estimated lifetime damage from wrongly blocking a genuine customer. */
  readonly falseDeclineGoodwillMinor: number;
  /** Fully loaded cost of one analyst review. */
  readonly analystReviewMinor: number;
  /** Share of escalated cases an analyst resolves correctly, in bps. */
  readonly analystAccuracyBps: number;
}

export const DEFAULT_COSTS: CostModel = {
  chargebackFeeMinor: 150_000,
  lossGivenFraudBps: 10_000,
  marginBps: 1_200,
  falseDeclineGoodwillMinor: 90_000,
  analystReviewMinor: 12_000,
  analystAccuracyBps: 8_500,
};

export interface Decision {
  readonly action: Action;
  readonly expectedCostMinor: number;
  readonly alternatives: Readonly<Record<Action, number>>;
}

/**
 * Expected cost of each action at a given fraud probability, then the cheapest one.
 *
 * Confirming blocks the payment: it costs the lost margin and goodwill when the
 * transaction was genuine. Clearing lets it through: it costs the goods and the
 * chargeback fee when it was fraud. Escalating buys an analyst's judgement — it always
 * costs their time, and still carries whatever they get wrong.
 */
export function decide(
  fraudProbability: number,
  amountMinor: number,
  costs: CostModel = DEFAULT_COSTS,
): Decision {
  const p = Math.max(0, Math.min(1, fraudProbability));
  const fraudLoss = (amountMinor * costs.lossGivenFraudBps) / 10_000 + costs.chargebackFeeMinor;
  const genuineValue = (amountMinor * costs.marginBps) / 10_000 + costs.falseDeclineGoodwillMinor;

  const confirmCost = (1 - p) * genuineValue;
  const clearCost = p * fraudLoss;

  const analystErrorRate = 1 - costs.analystAccuracyBps / 10_000;
  const escalateCost =
    costs.analystReviewMinor + analystErrorRate * (p * fraudLoss + (1 - p) * genuineValue);

  const alternatives: Record<Action, number> = {
    confirm: confirmCost,
    clear: clearCost,
    escalate: escalateCost,
  };
  const action = (Object.keys(alternatives) as Action[]).reduce((best, candidate) =>
    alternatives[candidate] < alternatives[best] ? candidate : best,
  );

  return { action, expectedCostMinor: Math.round(alternatives[action]), alternatives };
}

/**
 * The probabilities at which the cheapest action changes, for a given amount.
 *
 * Derived by scanning rather than solved algebraically: the boundaries move with the
 * amount, and reporting them is how the policy explains itself.
 */
export function decisionBoundaries(
  amountMinor: number,
  costs: CostModel = DEFAULT_COSTS,
): { clearBelow: number; confirmAbove: number } {
  let clearBelow = 1;
  let confirmAbove = 1;
  let previous: Action = decide(0, amountMinor, costs).action;
  for (let step = 1; step <= 10_000; step += 1) {
    const p = step / 10_000;
    const action = decide(p, amountMinor, costs).action;
    if (action !== previous) {
      if (previous === "clear") clearBelow = p;
      if (action === "confirm") confirmAbove = p;
      previous = action;
    }
  }
  return { clearBelow, confirmAbove };
}

/** Realised cost of a decision once the truth is known; the evaluation's headline metric. */
export function realisedCostMinor(
  action: Action,
  wasFraud: boolean,
  amountMinor: number,
  costs: CostModel = DEFAULT_COSTS,
): number {
  const fraudLoss = (amountMinor * costs.lossGivenFraudBps) / 10_000 + costs.chargebackFeeMinor;
  const genuineValue = (amountMinor * costs.marginBps) / 10_000 + costs.falseDeclineGoodwillMinor;
  const analystErrorRate = 1 - costs.analystAccuracyBps / 10_000;

  switch (action) {
    case "confirm":
      return wasFraud ? 0 : genuineValue;
    case "clear":
      return wasFraud ? fraudLoss : 0;
    case "escalate":
      return costs.analystReviewMinor + analystErrorRate * (wasFraud ? fraudLoss : genuineValue);
    default:
      return 0;
  }
}
