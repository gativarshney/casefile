import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  calibrate,
  choleskySolve,
  fitCalibrator,
  fitLogistic,
  type LogisticModel,
  objective,
  predict,
  sigmoid,
} from "../src/scoring/logistic.js";

interface ReferenceCase {
  readonly name: string;
  readonly lambda: number;
  readonly features: number[][];
  readonly labels: number[];
  readonly intercept: number;
  readonly coefficients: number[];
}

const REFERENCE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../tools/reference/sklearn_reference.json", import.meta.url)),
    "utf8",
  ),
) as { cases: ReferenceCase[] };

const asBooleans = (labels: readonly number[]): boolean[] => labels.map((value) => value === 1);

describe("cholesky solve", () => {
  it("solves a known system", () => {
    const matrix = [
      [4, 2],
      [2, 3],
    ];
    const solution = choleskySolve(matrix, [10, 8]);
    expect(solution[0]).toBeCloseTo(1.75, 10);
    expect(solution[1]).toBeCloseTo(1.5, 10);
  });

  it("round-trips: A x reproduces b", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.double({ min: 2, max: 9, noNaN: true }),
          fc.double({ min: -1, max: 1, noNaN: true }),
          fc.double({ min: 2, max: 9, noNaN: true }),
          fc.double({ min: -5, max: 5, noNaN: true }),
          fc.double({ min: -5, max: 5, noNaN: true }),
        ),
        ([a, b, c, r0, r1]) => {
          const matrix = [
            [a, b],
            [b, c],
          ];
          if (a * c - b * b <= 1e-6) return;
          const x = choleskySolve(matrix, [r0, r1]);
          expect(a * (x[0] as number) + b * (x[1] as number)).toBeCloseTo(r0, 8);
          expect(b * (x[0] as number) + c * (x[1] as number)).toBeCloseTo(r1, 8);
        },
      ),
    );
  });

  it("refuses a matrix that is not positive definite", () => {
    expect(() =>
      choleskySolve(
        [
          [1, 2],
          [2, 1],
        ],
        [1, 1],
      ),
    ).toThrow(/positive definite/);
  });
});

describe("agreement with the scikit-learn reference", () => {
  it.each(REFERENCE.cases.map((c) => [c.name, c] as const))(
    "%s: predicted probabilities match",
    (_name, reference) => {
      const fit = fitLogistic(reference.features, asBooleans(reference.labels), {
        l2: reference.lambda,
      });
      const theirs: LogisticModel = {
        intercept: reference.intercept,
        coefficients: reference.coefficients,
      };
      let worst = 0;
      for (const row of reference.features) {
        worst = Math.max(worst, Math.abs(predict(fit, row) - predict(theirs, row)));
      }
      expect(worst).toBeLessThan(1e-5);
    },
  );

  it.each(REFERENCE.cases.map((c) => [c.name, c] as const))(
    "%s: our fit reaches an objective no worse than theirs",
    (_name, reference) => {
      // Where coefficients differ at the 1e-6 level, this decides which solver is
      // actually closer to the optimum rather than assuming the reference is exact.
      const labels = asBooleans(reference.labels);
      const ours = fitLogistic(reference.features, labels, { l2: reference.lambda });
      const theirs: LogisticModel = {
        intercept: reference.intercept,
        coefficients: reference.coefficients,
      };
      const ourObjective = objective(ours, reference.features, labels, reference.lambda);
      const theirObjective = objective(theirs, reference.features, labels, reference.lambda);
      expect(ourObjective).toBeLessThanOrEqual(theirObjective + 1e-9);
    },
  );

  it("converges in a handful of Newton steps on every case", () => {
    for (const reference of REFERENCE.cases) {
      const fit = fitLogistic(reference.features, asBooleans(reference.labels), {
        l2: reference.lambda,
      });
      expect(fit.converged, reference.name).toBe(true);
      expect(fit.iterations, reference.name).toBeLessThan(20);
    }
  });
});

describe("fitting behaviour", () => {
  const separable = {
    features: [[-2], [-1.5], [-1], [1], [1.5], [2]],
    labels: [false, false, false, true, true, true],
  };

  it("is deterministic", () => {
    const first = fitLogistic(separable.features, separable.labels);
    const second = fitLogistic(separable.features, separable.labels);
    expect(first).toEqual(second);
  });

  it("keeps separable data finite, which is what the ridge is for", () => {
    const ridged = fitLogistic(separable.features, separable.labels, { l2: 1 });
    expect(Number.isFinite(ridged.coefficients[0] as number)).toBe(true);
    expect(Math.abs(ridged.coefficients[0] as number)).toBeLessThan(10);
  });

  it("a weaker ridge permits a larger coefficient on separable data", () => {
    const strong = fitLogistic(separable.features, separable.labels, { l2: 10 });
    const weak = fitLogistic(separable.features, separable.labels, { l2: 0.01 });
    expect(Math.abs(weak.coefficients[0] as number)).toBeGreaterThan(
      Math.abs(strong.coefficients[0] as number),
    );
  });

  it("recovers the direction of a known relationship", () => {
    const features = Array.from({ length: 200 }, (_, i) => [i / 100]);
    const labels = features.map((row) => (row[0] as number) > 1);
    expect(fitLogistic(features, labels).coefficients[0] as number).toBeGreaterThan(0);
  });

  it("weighting positives raises predicted risk for the rare class", () => {
    const features = Array.from({ length: 400 }, (_, i) => [i < 20 ? 1 : 0]);
    const labels = features.map((row) => (row[0] as number) === 1);
    const plain = fitLogistic(features, labels, { l2: 1 });
    const weighted = fitLogistic(features, labels, { l2: 1, positiveWeight: 10 });
    expect(predict(weighted, [1])).toBeGreaterThan(predict(plain, [1]));
  });

  it("refuses to fit nothing", () => {
    expect(() => fitLogistic([], [])).toThrow(/no observations/);
  });
});

describe("sigmoid", () => {
  it("is symmetric about zero", () => {
    fc.assert(
      fc.property(fc.double({ min: -30, max: 30, noNaN: true }), (z) => {
        expect(sigmoid(z) + sigmoid(-z)).toBeCloseTo(1, 12);
      }),
    );
  });

  it("stays inside the unit interval at extreme inputs", () => {
    for (const z of [-1e6, -100, 0, 100, 1e6]) {
      const value = sigmoid(z);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

describe("calibration", () => {
  it("maps scores onto probabilities monotonically", () => {
    const scores = Array.from({ length: 300 }, (_, i) => (i - 150) / 30);
    const labels = scores.map((score) => sigmoid(score * 0.8 - 0.4) > 0.5);
    const calibrator = fitCalibrator(scores, labels);
    const low = calibrate(calibrator, -2);
    const high = calibrate(calibrator, 2);
    expect(high).toBeGreaterThan(low);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(1);
  });

  it("moves an over-confident score towards the observed rate", () => {
    // Scores are strongly positive but only a third of the rows are positive, so a
    // calibrated probability must land well below what the raw score implies.
    const scores = Array.from({ length: 300 }, () => 3);
    const labels = scores.map((_, index) => index % 3 === 0);
    const calibrator = fitCalibrator(
      scores.map((score, index) => score + (index % 7) / 10),
      labels,
    );
    expect(calibrate(calibrator, 3)).toBeLessThan(0.75);
  });
});
