import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { raiseAlerts } from "../alerting/rules.js";
import { CaseContext, FULL_SWEEP, probeById } from "../probes/index.js";
import { fitCalibrator, fitLogistic } from "../scoring/logistic.js";
import { type FrozenModel, freezeModel } from "../scoring/model.js";
import { deriveFindings } from "../verify/findings.js";
import { FEATURE_NAMES, FEATURE_SIGNS, toFeatureVector } from "../verify/verifier.js";
import { LabelReader, TRANSACTION_LABELS } from "../world/labels.js";
import { TRANSACTIONS } from "../world/schema.js";
import { WorldReader } from "../world/store.js";
import { type Fold, splitByComponent } from "./split.js";

export interface TrainingRow {
  readonly txnId: string;
  readonly customerId: string | null;
  readonly features: number[];
  readonly isFraud: boolean;
  readonly fold: Fold;
  readonly amountMinor: number;
}

export interface TrainingSet {
  readonly rows: readonly TrainingRow[];
  readonly featureNames: readonly string[];
}

/**
 * Builds the feature matrix by running the full probe sweep over every alert.
 *
 * The verifier is trained on exactly what it will see in production: the output of the
 * upstream rules engine, not the whole transaction stream. Precision and recall
 * therefore describe triage performance on an alert queue, which is the decision the
 * system actually makes.
 */
export function buildTrainingSet(worldPath: string, labelsPath: string): TrainingSet {
  const reader = new WorldReader(worldPath);
  const labels = new LabelReader(labelsPath);
  try {
    const fraudTxns = new Set(
      labels
        .all(TRANSACTION_LABELS)
        .filter((label) => label.isFraud)
        .map((label) => label.txnId),
    );
    const folds = splitByComponent(reader);
    const rows: TrainingRow[] = [];

    for (const alert of raiseAlerts(reader)) {
      const subject = reader.get(TRANSACTIONS, alert.txnId);
      if (!subject) continue;
      const context = new CaseContext(reader, subject);
      const evidence = FULL_SWEEP.map((id) => probeById(id).run(context)).filter(
        (item): item is NonNullable<typeof item> => item !== null,
      );
      rows.push({
        txnId: subject.txnId,
        customerId: subject.customerId,
        features: toFeatureVector(deriveFindings(evidence)),
        isFraud: fraudTxns.has(subject.txnId),
        fold: subject.customerId ? (folds.get(subject.customerId) ?? "fit") : "fit",
        amountMinor: subject.amountMinor,
      });
    }
    return { rows, featureNames: FEATURE_NAMES };
  } finally {
    reader.close();
    labels.close();
  }
}

export interface TrainOptions {
  readonly l2?: number;
  readonly positiveWeight?: number;
}

export interface TrainResult {
  readonly model: FrozenModel;
  readonly fitRows: number;
  readonly calibrateRows: number;
  readonly fitPositives: number;
  readonly iterations: number;
}

export function trainModel(
  training: TrainingSet,
  provenance: FrozenModel["trainedOn"],
  options: TrainOptions = {},
): TrainResult {
  const { l2 = 1, positiveWeight = 6 } = options;
  const fitRows = training.rows.filter((row) => row.fold === "fit");
  const calibrateRows = training.rows.filter((row) => row.fold === "calibrate");
  if (fitRows.length === 0) throw new Error("the fitting fold is empty");

  const fit = fitLogistic(
    fitRows.map((row) => row.features),
    fitRows.map((row) => row.isFraud),
    { l2, positiveWeight, signs: FEATURE_SIGNS },
  );

  // Calibration is fitted on the held-back fold: probabilities learned on the same rows
  // that trained the coefficients would be over-confident by construction.
  const calibrationSource = calibrateRows.length >= 50 ? calibrateRows : fitRows;
  const rawScores = calibrationSource.map(
    (row) =>
      fit.intercept +
      row.features.reduce(
        (sum, value, index) => sum + (fit.coefficients[index] as number) * value,
        0,
      ),
  );
  const calibrator = fitCalibrator(
    rawScores,
    calibrationSource.map((row) => row.isFraud),
  );

  return {
    model: freezeModel(fit, calibrator, training.featureNames, provenance, { l2, positiveWeight }),
    fitRows: fitRows.length,
    calibrateRows: calibrateRows.length,
    fitPositives: fitRows.filter((row) => row.isFraud).length,
    iterations: fit.iterations,
  };
}

export function writeModel(path: string, model: FrozenModel): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(model, null, 2)}\n`, "utf8");
}
