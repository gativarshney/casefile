/**
 * L2-regularised logistic regression, fitted by iteratively reweighted least squares.
 *
 * IRLS is Newton's method for this objective: each step solves a weighted least-squares
 * system, and convergence is quadratic, so the fit reaches machine precision in under a
 * dozen iterations. Gradient descent was measured against it first and left coefficients
 * still moving after thousands of steps, which would have made them a function of the
 * iteration count rather than of the data — unacceptable when the whole point is that a
 * sealed case reproduces exactly.
 *
 * The ridge term is not optional. On separable data the unpenalised maximum-likelihood
 * estimate diverges; with a ridge the Hessian stays positive definite and the solution
 * stays finite. It is applied to the weights only, leaving the intercept free, which
 * matches the convention scikit-learn uses under lbfgs and lets the two be compared
 * directly. `tests/scoring.test.ts` pins that agreement against a committed fixture.
 */

export interface LogisticModel {
  readonly intercept: number;
  readonly coefficients: readonly number[];
}

/**
 * Permitted sign for a coefficient: `1` non-negative, `-1` non-positive, `0` free.
 *
 * Findings declare whether they argue for or against fraud, and the fitted model has to
 * agree. Without this, collinear evidence flips signs — card testing always shows both a
 * spread of issuers and a wall of hard declines, so an unconstrained fit happily loads
 * one and *subtracts* the other. The likelihood barely notices; a reviewer told that
 * hard declines reduce risk stops trusting the system immediately.
 *
 * Constraining the sign costs a little log-likelihood and buys monotonicity: evidence
 * against the customer can never lower the score. Credit risk models are constrained
 * this way for the same reason.
 */
export type Sign = -1 | 0 | 1;

export interface FitOptions {
  readonly l2?: number;
  readonly maxIterations?: number;
  readonly tolerance?: number;
  /** Multiplier applied to positive rows; fraud is rare and would otherwise be ignored. */
  readonly positiveWeight?: number;
  readonly signs?: readonly Sign[];
}

export interface FitResult extends LogisticModel {
  readonly iterations: number;
  readonly converged: boolean;
}

export function sigmoid(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

/**
 * Solves `A x = b` for symmetric positive-definite `A` by Cholesky factorisation.
 * The IRLS Hessian is positive definite once the ridge is added, so no pivoting is
 * required and failure to factorise indicates a malformed system rather than a hard case.
 */
export function choleskySolve(
  matrix: readonly (readonly number[])[],
  rhs: readonly number[],
): number[] {
  const size = rhs.length;
  const lower = matrix.map((row) => [...row]);

  for (let j = 0; j < size; j += 1) {
    const rowJ = lower[j] as number[];
    for (let k = 0; k < j; k += 1) rowJ[j] = (rowJ[j] as number) - (rowJ[k] as number) ** 2;
    const pivot = rowJ[j] as number;
    if (!(pivot > 0) || !Number.isFinite(pivot)) {
      throw new Error("matrix is not positive definite; the ridge term is too small");
    }
    rowJ[j] = Math.sqrt(pivot);
    for (let i = j + 1; i < size; i += 1) {
      const rowI = lower[i] as number[];
      for (let k = 0; k < j; k += 1) {
        rowI[j] = (rowI[j] as number) - (rowI[k] as number) * (rowJ[k] as number);
      }
      rowI[j] = (rowI[j] as number) / (rowJ[j] as number);
    }
  }

  const forward = new Array<number>(size).fill(0);
  for (let i = 0; i < size; i += 1) {
    let sum = rhs[i] as number;
    const rowI = lower[i] as number[];
    for (let k = 0; k < i; k += 1) sum -= (rowI[k] as number) * (forward[k] as number);
    forward[i] = sum / (rowI[i] as number);
  }

  const solution = new Array<number>(size).fill(0);
  for (let i = size - 1; i >= 0; i -= 1) {
    let sum = forward[i] as number;
    for (let k = i + 1; k < size; k += 1) {
      sum -= ((lower[k] as number[])[i] as number) * (solution[k] as number);
    }
    solution[i] = sum / ((lower[i] as number[])[i] as number);
  }
  return solution;
}

export function fitLogistic(
  features: readonly (readonly number[])[],
  labels: readonly boolean[],
  options: FitOptions = {},
): FitResult {
  const { l2 = 1, maxIterations = 200, tolerance = 1e-11, positiveWeight = 1, signs } = options;
  if (features.length === 0) throw new Error("cannot fit a model with no observations");

  const rows = features.length;
  const width = (features[0] as readonly number[]).length + 1;
  const design = features.map((row) => [1, ...row]);
  const beta = new Array<number>(width).fill(0);
  const held = new Array<boolean>(width).fill(false);

  let iterations = 0;
  let converged = false;
  for (; iterations < maxIterations; iterations += 1) {
    const hessian = Array.from({ length: width }, () => new Array<number>(width).fill(0));
    const gradient = new Array<number>(width).fill(0);

    for (let i = 0; i < rows; i += 1) {
      const row = design[i] as number[];
      let z = 0;
      for (let j = 0; j < width; j += 1) z += (beta[j] as number) * (row[j] as number);
      const probability = sigmoid(z);
      const sampleWeight = labels[i] ? positiveWeight : 1;
      // Floor keeps the Hessian well conditioned when a row is confidently classified.
      const curvature = Math.max(probability * (1 - probability), 1e-10) * sampleWeight;
      const residual = ((labels[i] ? 1 : 0) - probability) * sampleWeight;

      for (let a = 0; a < width; a += 1) {
        gradient[a] = (gradient[a] as number) + residual * (row[a] as number);
        const hessianRow = hessian[a] as number[];
        for (let b = a; b < width; b += 1) {
          hessianRow[b] =
            (hessianRow[b] as number) + curvature * (row[a] as number) * (row[b] as number);
        }
      }
    }

    for (let a = 0; a < width; a += 1) {
      for (let b = a + 1; b < width; b += 1) {
        (hessian[b] as number[])[a] = (hessian[a] as number[])[b] as number;
      }
    }
    for (let a = 1; a < width; a += 1) {
      (hessian[a] as number[])[a] = ((hessian[a] as number[])[a] as number) + l2;
      gradient[a] = (gradient[a] as number) - l2 * (beta[a] as number);
    }

    // Active-set projected Newton. Coefficients resting on their sign boundary are held
    // at zero and removed from the system rather than re-clamped each step: clamping
    // alone lets a coefficient oscillate across the boundary and never settle. A held
    // coefficient is released as soon as its gradient points back into the feasible
    // region, so the active set is discovered rather than assumed.
    if (signs) {
      for (const [index, sign] of signs.entries()) {
        const position = index + 1;
        if (!held[position]) continue;
        const wantsToMove = (gradient[position] as number) * sign;
        if (wantsToMove > tolerance) held[position] = false;
      }
    }

    const free: number[] = [];
    for (let j = 0; j < width; j += 1) if (!held[j]) free.push(j);

    const reducedHessian = free.map((row) =>
      free.map((col) => (hessian[row] as number[])[col] as number),
    );
    const reducedGradient = free.map((index) => gradient[index] as number);
    const reducedStep = choleskySolve(reducedHessian, reducedGradient);

    let movement = 0;
    let setChanged = false;
    for (const [slot, index] of free.entries()) {
      const previous = beta[index] as number;
      let next = previous + (reducedStep[slot] as number);
      if (signs && index > 0) {
        const sign = signs[index - 1] as Sign;
        if ((sign === 1 && next < 0) || (sign === -1 && next > 0)) {
          next = 0;
          held[index] = true;
          setChanged = true;
        }
      }
      beta[index] = next;
      movement = Math.max(movement, Math.abs(next - previous));
    }

    if (movement < tolerance && !setChanged) {
      iterations += 1;
      converged = true;
      break;
    }
  }

  return {
    intercept: beta[0] as number,
    coefficients: beta.slice(1),
    iterations,
    converged,
  };
}

export function logOdds(model: LogisticModel, features: readonly number[]): number {
  let total = model.intercept;
  for (const [index, value] of features.entries()) {
    total += (model.coefficients[index] as number) * value;
  }
  return total;
}

export function predict(model: LogisticModel, features: readonly number[]): number {
  return sigmoid(logOdds(model, features));
}

/**
 * Penalised negative log-likelihood. Used to verify that a fit reached a lower objective
 * than a reference implementation rather than merely landing near it.
 */
export function objective(
  model: LogisticModel,
  features: readonly (readonly number[])[],
  labels: readonly boolean[],
  l2: number,
): number {
  let total = 0;
  for (const [index, row] of features.entries()) {
    const probability = predict(model, row);
    total -= labels[index]
      ? Math.log(Math.max(probability, 1e-300))
      : Math.log(Math.max(1 - probability, 1e-300));
  }
  return total + (l2 / 2) * model.coefficients.reduce((sum, value) => sum + value * value, 0);
}

/**
 * Platt scaling: a one-dimensional logistic regression mapping raw scores onto
 * probabilities. Reusing the same fitter for calibration means there is one numerical
 * routine to trust rather than two.
 */
export interface Calibrator {
  readonly slope: number;
  readonly offset: number;
}

export function fitCalibrator(scores: readonly number[], labels: readonly boolean[]): Calibrator {
  const fit = fitLogistic(
    scores.map((score) => [score]),
    labels,
    { l2: 1e-6 },
  );
  return { slope: fit.coefficients[0] as number, offset: fit.intercept };
}

export function calibrate(calibrator: Calibrator, score: number): number {
  return sigmoid(calibrator.slope * score + calibrator.offset);
}
