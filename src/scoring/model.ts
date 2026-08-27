import { readFileSync } from "node:fs";
import { quantise } from "../canon/canonical.js";
import { digest } from "../canon/hash.js";
import { type Calibrator, calibrate, type LogisticModel, logOdds } from "./logistic.js";

/**
 * A fitted model, frozen for use.
 *
 * Coefficients are stored as fixed-precision decimal strings rather than floats. A model
 * is part of the sealed state a case commits to, and a float would make that commitment
 * depend on how a particular runtime formats a double. Scoring parses them back once at
 * load, so the arithmetic is ordinary floating point and only the *stored* form is
 * constrained.
 */
export interface FrozenModel {
  readonly version: number;
  readonly featureNames: readonly string[];
  readonly intercept: string;
  readonly coefficients: readonly string[];
  readonly calibration: { readonly slope: string; readonly offset: string };
  readonly trainedOn: {
    readonly world: string;
    readonly specDigest: string;
    readonly alerts: number;
    readonly positives: number;
  };
  readonly l2: number;
  readonly positiveWeight: number;
}

export const MODEL_PRECISION = 8;

export function freezeModel(
  model: LogisticModel,
  calibrator: Calibrator,
  featureNames: readonly string[],
  trainedOn: FrozenModel["trainedOn"],
  hyperparameters: { l2: number; positiveWeight: number },
): FrozenModel {
  return {
    version: 1,
    featureNames: [...featureNames],
    intercept: quantise(model.intercept, MODEL_PRECISION),
    coefficients: model.coefficients.map((value) => quantise(value, MODEL_PRECISION)),
    calibration: {
      slope: quantise(calibrator.slope, MODEL_PRECISION),
      offset: quantise(calibrator.offset, MODEL_PRECISION),
    },
    trainedOn,
    l2: hyperparameters.l2,
    positiveWeight: hyperparameters.positiveWeight,
  };
}

export function thawModel(frozen: FrozenModel): { model: LogisticModel; calibrator: Calibrator } {
  return {
    model: {
      intercept: Number(frozen.intercept),
      coefficients: frozen.coefficients.map(Number),
    },
    calibrator: {
      slope: Number(frozen.calibration.slope),
      offset: Number(frozen.calibration.offset),
    },
  };
}

/** Identifies exactly which model produced a verdict; sealed into every case artifact. */
export function modelHash(frozen: FrozenModel): string {
  return digest(frozen as unknown as Record<string, unknown>);
}

export function loadModel(path: string): FrozenModel {
  return JSON.parse(readFileSync(path, "utf8")) as FrozenModel;
}

/** Fixed-precision strings so a contribution can be sealed into a case artifact. */
export interface Contribution {
  readonly feature: string;
  readonly value: string;
  readonly coefficient: string;
  readonly logOdds: string;
}

/**
 * The score together with each feature's exact contribution in log-odds.
 *
 * This is what makes the verdict inspectable: a reviewer can add the contributions to
 * the intercept and arrive at the same number the system used, then follow any one of
 * them back to the finding and the record it came from.
 */
export function scoreWithContributions(
  frozen: FrozenModel,
  features: readonly number[],
): {
  logOdds: number;
  rawProbability: number;
  calibratedProbability: number;
  contributions: Contribution[];
} {
  const { model, calibrator } = thawModel(frozen);
  const total = logOdds(model, features);
  const contributions = frozen.featureNames
    .map((feature, index) => ({
      feature,
      rawValue: features[index] as number,
      rawLogOdds: (model.coefficients[index] as number) * (features[index] as number),
      coefficient: model.coefficients[index] as number,
    }))
    .filter((contribution) => contribution.rawValue !== 0)
    .sort((a, b) => Math.abs(b.rawLogOdds) - Math.abs(a.rawLogOdds))
    .map((contribution) => ({
      feature: contribution.feature,
      value: quantise(contribution.rawValue, 6),
      coefficient: quantise(contribution.coefficient, MODEL_PRECISION),
      logOdds: quantise(contribution.rawLogOdds, 6),
    }));

  return {
    logOdds: total,
    rawProbability: 1 / (1 + Math.exp(-total)),
    calibratedProbability: calibrate(calibrator, total),
    contributions,
  };
}
