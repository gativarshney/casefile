export interface ConfusionMatrix {
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly trueNegatives: number;
  readonly falseNegatives: number;
}

export interface ClassificationMetrics extends ConfusionMatrix {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly falsePositiveRate: number;
  readonly support: number;
  readonly positives: number;
}

export function confusion(
  predicted: readonly boolean[],
  actual: readonly boolean[],
): ConfusionMatrix {
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;
  for (const [index, isPredicted] of predicted.entries()) {
    const isActual = actual[index] === true;
    if (isPredicted && isActual) truePositives += 1;
    else if (isPredicted && !isActual) falsePositives += 1;
    else if (!isPredicted && isActual) falseNegatives += 1;
    else trueNegatives += 1;
  }
  return { truePositives, falsePositives, trueNegatives, falseNegatives };
}

export function classify(
  predicted: readonly boolean[],
  actual: readonly boolean[],
): ClassificationMetrics {
  const matrix = confusion(predicted, actual);
  const { truePositives, falsePositives, trueNegatives, falseNegatives } = matrix;
  const precision =
    truePositives + falsePositives === 0 ? 0 : truePositives / (truePositives + falsePositives);
  const recall =
    truePositives + falseNegatives === 0 ? 0 : truePositives / (truePositives + falseNegatives);
  return {
    ...matrix,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    falsePositiveRate:
      falsePositives + trueNegatives === 0 ? 0 : falsePositives / (falsePositives + trueNegatives),
    support: predicted.length,
    positives: truePositives + falseNegatives,
  };
}

/**
 * Area under the precision-recall curve by the trapezoid rule.
 *
 * PR-AUC rather than ROC-AUC because the classes are heavily imbalanced: ROC-AUC stays
 * flattering when almost everything is negative, while precision-recall reflects what an
 * analyst working a queue actually experiences.
 */
export function prAuc(scores: readonly number[], actual: readonly boolean[]): number {
  const positives = actual.filter(Boolean).length;
  if (positives === 0 || positives === actual.length) return 0;

  const ordered = scores
    .map((score, index) => ({ score, positive: actual[index] === true }))
    .sort((a, b) => b.score - a.score);

  let truePositives = 0;
  let falsePositives = 0;
  let previousRecall = 0;
  let area = 0;
  let index = 0;

  while (index < ordered.length) {
    const threshold = (ordered[index] as { score: number }).score;
    while (index < ordered.length && (ordered[index] as { score: number }).score === threshold) {
      if ((ordered[index] as { positive: boolean }).positive) truePositives += 1;
      else falsePositives += 1;
      index += 1;
    }
    const precision = truePositives / (truePositives + falsePositives);
    const recall = truePositives / positives;
    area += (recall - previousRecall) * precision;
    previousRecall = recall;
  }
  return area;
}

export interface CalibrationBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly predicted: number;
  readonly observed: number;
}

export interface CalibrationReport {
  readonly brier: number;
  readonly expectedCalibrationError: number;
  readonly bins: readonly CalibrationBin[];
}

/**
 * Brier score and expected calibration error over equal-width bins.
 *
 * A verdict that says "72% likely fraud" is only useful if roughly 72% of such cases
 * are fraud. Reporting calibration keeps the probability honest rather than treating it
 * as an unlabelled ranking score.
 */
export function calibration(
  probabilities: readonly number[],
  actual: readonly boolean[],
  binCount = 10,
): CalibrationReport {
  const brier =
    probabilities.reduce((sum, probability, index) => {
      const outcome = actual[index] ? 1 : 0;
      return sum + (probability - outcome) ** 2;
    }, 0) / Math.max(1, probabilities.length);

  const bins: CalibrationBin[] = [];
  let expectedCalibrationError = 0;

  for (let bin = 0; bin < binCount; bin += 1) {
    const lower = bin / binCount;
    const upper = (bin + 1) / binCount;
    const members = probabilities
      .map((probability, index) => ({ probability, positive: actual[index] === true }))
      .filter(
        ({ probability }) =>
          probability >= lower &&
          (bin === binCount - 1 ? probability <= upper : probability < upper),
      );
    if (members.length === 0) {
      bins.push({ lower, upper, count: 0, predicted: 0, observed: 0 });
      continue;
    }
    const predicted = members.reduce((sum, member) => sum + member.probability, 0) / members.length;
    const observed = members.filter((member) => member.positive).length / members.length;
    expectedCalibrationError +=
      (members.length / probabilities.length) * Math.abs(predicted - observed);
    bins.push({ lower, upper, count: members.length, predicted, observed });
  }

  return { brier, expectedCalibrationError, bins };
}
