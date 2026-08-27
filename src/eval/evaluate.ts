import { raiseAlerts } from "../alerting/rules.js";
import { CaseContext, FULL_SWEEP, probeById } from "../probes/index.js";
import { type FrozenModel, modelHash, scoreWithContributions } from "../scoring/model.js";
import { deriveFindings } from "../verify/findings.js";
import {
  type Action,
  type CostModel,
  DEFAULT_COSTS,
  decide,
  realisedCostMinor,
} from "../verify/policy.js";
import { toFeatureVector } from "../verify/verifier.js";
import { LabelReader, TRANSACTION_LABELS, type TransactionLabel } from "../world/labels.js";
import { TRANSACTIONS } from "../world/schema.js";
import { type DatasetManifest, WorldReader } from "../world/store.js";
import {
  type CalibrationReport,
  type ClassificationMetrics,
  calibration,
  classify,
  prAuc,
} from "./metrics.js";

export interface ScoredAlert {
  readonly txnId: string;
  readonly amountMinor: number;
  readonly probability: number;
  readonly action: Action;
  readonly isFraud: boolean;
  readonly family: string | null;
  readonly variant: string | null;
  readonly decoyKind: string | null;
  readonly archetype: string | null;
}

export interface BaselineResult {
  readonly name: string;
  readonly description: string;
  readonly metrics: ClassificationMetrics;
  readonly costMinor: number;
}

export interface CohortResult {
  readonly name: string;
  readonly count: number;
  /** Blocked outright. */
  readonly blocked: number;
  /** Blocked or escalated — that is, not silently let through. */
  readonly caught: number;
  readonly blockRate: number;
  readonly catchRate: number;
}

/**
 * What the whole pipeline achieves, not just the triage stage.
 *
 * Triage metrics are computed over the alert queue, so fraud the upstream rules engine
 * never flags is invisible to them. Reporting end-to-end recall alongside keeps the
 * headline honest: a mechanism that evades alerting is not caught by anything
 * downstream, however good the verifier is.
 */
export interface EndToEndResult {
  readonly fraudInWorld: number;
  readonly fraudReachingQueue: number;
  readonly fraudBlocked: number;
  readonly fraudNotCleared: number;
  readonly alertingRecall: number;
  readonly endToEndBlockRate: number;
  readonly invisibleToAlerting: readonly CohortResult[];
}

export interface EvaluationReport {
  readonly world: string;
  readonly worldRoot: string;
  readonly modelHash: string;
  readonly totalTransactions: number;
  readonly alerts: number;
  readonly alertRate: number;
  readonly fraudInAlerts: number;
  readonly casefile: ClassificationMetrics;
  /**
   * Treating escalation as a catch rather than a miss. Blocking and escalating are both
   * successful outcomes for a triage system — the failure mode is clearing fraud — so
   * both framings are reported and neither is allowed to stand alone.
   */
  readonly casefileCaught: ClassificationMetrics;
  readonly endToEnd: EndToEndResult;
  readonly prAuc: number;
  readonly calibration: CalibrationReport;
  readonly baselines: readonly BaselineResult[];
  readonly perFamily: readonly CohortResult[];
  readonly perVariant: readonly CohortResult[];
  readonly decoyCohorts: readonly CohortResult[];
  readonly actionCounts: Readonly<Record<Action, number>>;
  readonly autoDecisionRate: number;
  readonly analystHoursSaved: number;
  readonly costs: {
    readonly casefileMinor: number;
    readonly rulesOnlyMinor: number;
    readonly clearAllMinor: number;
    readonly savedVsRulesMinor: number;
  };
}

const ANALYST_MINUTES_PER_CASE = 9;

export function scoreAlerts(
  worldPath: string,
  labelsPath: string,
  model: FrozenModel,
  costs: CostModel = DEFAULT_COSTS,
): ScoredAlert[] {
  const reader = new WorldReader(worldPath);
  const labels = new LabelReader(labelsPath);
  try {
    const labelByTxn = new Map<string, TransactionLabel>(
      labels.all(TRANSACTION_LABELS).map((label) => [label.txnId, label]),
    );
    const scored: ScoredAlert[] = [];

    for (const alert of raiseAlerts(reader)) {
      const subject = reader.get(TRANSACTIONS, alert.txnId);
      if (!subject) continue;
      const context = new CaseContext(reader, subject);
      const evidence = FULL_SWEEP.map((id) => probeById(id).run(context)).filter(
        (item): item is NonNullable<typeof item> => item !== null,
      );
      const features = toFeatureVector(deriveFindings(evidence));
      const { calibratedProbability } = scoreWithContributions(model, features);
      const label = labelByTxn.get(subject.txnId);

      scored.push({
        txnId: subject.txnId,
        amountMinor: subject.amountMinor,
        probability: calibratedProbability,
        action: decide(calibratedProbability, subject.amountMinor, costs).action,
        isFraud: label?.isFraud === true,
        family: label?.family ?? null,
        variant: label?.variant ?? null,
        decoyKind: label?.decoyKind ?? null,
        archetype: label?.archetype ?? null,
      });
    }
    return scored;
  } finally {
    reader.close();
    labels.close();
  }
}

export function evaluate(
  worldPath: string,
  labelsPath: string,
  manifest: DatasetManifest,
  model: FrozenModel,
  worldName: string,
  costs: CostModel = DEFAULT_COSTS,
): EvaluationReport {
  const scored = scoreAlerts(worldPath, labelsPath, model, costs);

  const reader = new WorldReader(worldPath);
  const totalTransactions = reader.count(TRANSACTIONS.table);
  reader.close();

  const labelReader = new LabelReader(labelsPath);
  const allFraud = labelReader.all(TRANSACTION_LABELS).filter((label) => label.isFraud);
  labelReader.close();

  const actual = scored.map((row) => row.isFraud);
  // Confirm is the positive prediction: it is the action that blocks a payment.
  const predicted = scored.map((row) => row.action === "confirm");
  const casefile = classify(predicted, actual);
  const caught = classify(
    scored.map((row) => row.action !== "clear"),
    actual,
  );

  const actionCounts: Record<Action, number> = { confirm: 0, escalate: 0, clear: 0 };
  for (const row of scored) actionCounts[row.action] += 1;

  const casefileCost = scored.reduce(
    (sum, row) => sum + realisedCostMinor(row.action, row.isFraud, row.amountMinor, costs),
    0,
  );
  // Every alert reaching an analyst is what the rules engine alone implies.
  const rulesOnlyCost = scored.reduce(
    (sum, row) => sum + realisedCostMinor("escalate", row.isFraud, row.amountMinor, costs),
    0,
  );
  const clearAllCost = scored.reduce(
    (sum, row) => sum + realisedCostMinor("clear", row.isFraud, row.amountMinor, costs),
    0,
  );

  return {
    world: worldName,
    worldRoot: manifest.worldRoot,
    modelHash: modelHash(model),
    totalTransactions,
    alerts: scored.length,
    alertRate: scored.length / Math.max(1, totalTransactions),
    fraudInAlerts: actual.filter(Boolean).length,
    casefile,
    casefileCaught: caught,
    endToEnd: endToEndResult(allFraud, scored),
    prAuc: prAuc(
      scored.map((row) => row.probability),
      actual,
    ),
    calibration: calibration(
      scored.map((row) => row.probability),
      actual,
    ),
    baselines: buildBaselines(scored, costs),
    perFamily: cohortRecall(scored, (row) => row.family),
    perVariant: cohortRecall(scored, (row) => row.variant),
    decoyCohorts: decoyFalsePositives(scored),
    actionCounts,
    autoDecisionRate: (actionCounts.confirm + actionCounts.clear) / Math.max(1, scored.length),
    analystHoursSaved: ((scored.length - actionCounts.escalate) * ANALYST_MINUTES_PER_CASE) / 60,
    costs: {
      casefileMinor: Math.round(casefileCost),
      rulesOnlyMinor: Math.round(rulesOnlyCost),
      clearAllMinor: Math.round(clearAllCost),
      savedVsRulesMinor: Math.round(rulesOnlyCost - casefileCost),
    },
  };
}

/**
 * Baselines the verifier has to beat to have earned its place.
 *
 * The important one is `rules_only`: it is what the upstream engine achieves without
 * triage, and it is what Casefile is actually replacing. Publishing the naive baselines
 * alongside it is how a reader can tell whether the task was hard in the first place —
 * if `amount_threshold` scored well, none of the other numbers would mean anything.
 */
function buildBaselines(scored: readonly ScoredAlert[], costs: CostModel): BaselineResult[] {
  const actual = scored.map((row) => row.isFraud);
  const amounts = scored.map((row) => row.amountMinor).sort((a, b) => a - b);
  const highAmount = amounts[Math.floor(amounts.length * 0.9)] ?? 0;

  const definitions: readonly {
    name: string;
    description: string;
    predict: (row: ScoredAlert) => boolean;
    action: (row: ScoredAlert) => Action;
  }[] = [
    {
      name: "rules_only",
      description: "every alert goes to an analyst; no triage",
      predict: () => false,
      action: () => "escalate",
    },
    {
      name: "always_confirm",
      description: "block every alerted payment",
      predict: () => true,
      action: () => "confirm",
    },
    {
      name: "always_clear",
      description: "let every alerted payment through",
      predict: () => false,
      action: () => "clear",
    },
    {
      name: "amount_threshold",
      description: "block alerts in the top decile by value",
      predict: (row) => row.amountMinor >= highAmount,
      action: (row) => (row.amountMinor >= highAmount ? "confirm" : "clear"),
    },
  ];

  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description,
    metrics: classify(scored.map(definition.predict), actual),
    costMinor: Math.round(
      scored.reduce(
        (sum, row) =>
          sum + realisedCostMinor(definition.action(row), row.isFraud, row.amountMinor, costs),
        0,
      ),
    ),
  }));
}

function cohortRecall(
  scored: readonly ScoredAlert[],
  key: (row: ScoredAlert) => string | null,
): CohortResult[] {
  const groups = new Map<string, { count: number; blocked: number; caught: number }>();
  for (const row of scored) {
    if (!row.isFraud) continue;
    const name = key(row);
    if (name === null) continue;
    const group = groups.get(name) ?? { count: 0, blocked: 0, caught: 0 };
    group.count += 1;
    if (row.action === "confirm") group.blocked += 1;
    if (row.action !== "clear") group.caught += 1;
    groups.set(name, group);
  }
  return [...groups.entries()]
    .map(([name, group]) => ({
      name,
      count: group.count,
      blocked: group.blocked,
      caught: group.caught,
      blockRate: group.blocked / group.count,
      catchRate: group.caught / group.count,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** How often each hard-negative cohort is wrongly blocked. */
function decoyFalsePositives(scored: readonly ScoredAlert[]): CohortResult[] {
  const groups = new Map<string, { count: number; blocked: number; caught: number }>();
  for (const row of scored) {
    if (row.isFraud || row.decoyKind === null) continue;
    const group = groups.get(row.decoyKind) ?? { count: 0, blocked: 0, caught: 0 };
    group.count += 1;
    if (row.action === "confirm") group.blocked += 1;
    if (row.action !== "clear") group.caught += 1;
    groups.set(row.decoyKind, group);
  }
  return [...groups.entries()]
    .map(([name, group]) => ({
      name,
      count: group.count,
      blocked: group.blocked,
      caught: group.caught,
      blockRate: group.blocked / group.count,
      catchRate: group.caught / group.count,
    }))
    .sort((a, b) => b.blockRate - a.blockRate);
}

/**
 * Fraud never surfaced by the alerting layer, grouped by mechanism. A variant that
 * appears here defeated the pipeline before triage had anything to decide.
 */
function endToEndResult(
  allFraud: readonly TransactionLabel[],
  scored: readonly ScoredAlert[],
): EndToEndResult {
  const scoredByTxn = new Map(scored.map((row) => [row.txnId, row]));
  const groups = new Map<string, { count: number; blocked: number; caught: number }>();

  let blocked = 0;
  let notCleared = 0;
  let reached = 0;

  for (const label of allFraud) {
    const row = scoredByTxn.get(label.txnId);
    if (row) {
      reached += 1;
      if (row.action === "confirm") blocked += 1;
      if (row.action !== "clear") notCleared += 1;
    }
    const name = `${label.family}/${label.variant}`;
    const group = groups.get(name) ?? { count: 0, blocked: 0, caught: 0 };
    group.count += 1;
    if (row) group.caught += 1;
    if (row?.action === "confirm") group.blocked += 1;
    groups.set(name, group);
  }

  return {
    fraudInWorld: allFraud.length,
    fraudReachingQueue: reached,
    fraudBlocked: blocked,
    fraudNotCleared: notCleared,
    alertingRecall: reached / Math.max(1, allFraud.length),
    endToEndBlockRate: blocked / Math.max(1, allFraud.length),
    invisibleToAlerting: [...groups.entries()]
      .map(([name, group]) => ({
        name,
        count: group.count,
        blocked: group.blocked,
        caught: group.caught,
        blockRate: group.blocked / group.count,
        // Here "caught" means reached the queue at all.
        catchRate: group.caught / group.count,
      }))
      .sort((a, b) => a.catchRate - b.catchRate),
  };
}
