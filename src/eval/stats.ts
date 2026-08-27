export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] as number;
  if (lower === upper) return low;
  return low + ((sorted[upper] as number) - low) * (position - lower);
}

export function median(values: readonly number[]): number {
  return quantile(
    [...values].sort((a, b) => a - b),
    0.5,
  );
}

/**
 * Mann-Whitney U expressed as AUC: the probability a randomly chosen positive scores
 * above a randomly chosen negative. 0.5 means the feature is useless on its own, which
 * for a synthetic generator is the *desired* result for any single field.
 */
export function rocAuc(scores: readonly number[], labels: readonly boolean[]): number {
  const paired = scores
    .map((score, index) => ({ score, positive: labels[index] === true }))
    .sort((a, b) => a.score - b.score);
  const positives = paired.filter((p) => p.positive).length;
  const negatives = paired.length - positives;
  if (positives === 0 || negatives === 0) return 0.5;

  let rankSum = 0;
  let index = 0;
  while (index < paired.length) {
    let end = index;
    while (end + 1 < paired.length && paired[end + 1]?.score === paired[index]?.score) end += 1;
    const averageRank = (index + end) / 2 + 1;
    for (let k = index; k <= end; k += 1) {
      if (paired[k]?.positive) rankSum += averageRank;
    }
    index = end + 1;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/** Separation power of a single feature, folded so direction does not matter. */
export function separation(scores: readonly number[], labels: readonly boolean[]): number {
  const auc = rocAuc(scores, labels);
  return Math.max(auc, 1 - auc);
}

/**
 * Symmetrised KL divergence between two categorical distributions, with Laplace
 * smoothing so an unseen category does not produce infinity.
 */
export function categoricalDivergence(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): number {
  const keys = new Set([...a.keys(), ...b.keys()]);
  const totalA = [...a.values()].reduce((s, v) => s + v, 0) + keys.size;
  const totalB = [...b.values()].reduce((s, v) => s + v, 0) + keys.size;
  let divergence = 0;
  for (const key of keys) {
    const pa = ((a.get(key) ?? 0) + 1) / totalA;
    const pb = ((b.get(key) ?? 0) + 1) / totalB;
    divergence += (pa - pb) * Math.log(pa / pb);
  }
  return divergence;
}

export function counted<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}
/**
 * Divergence expected purely from drawing `sampleSize` observations out of `reference`.
 *
 * A fixed threshold on categorical divergence is not meaningful when one class has a
 * few hundred members: sampling noise alone produces a non-zero value. This returns the
 * upper percentile of the null distribution, so the check becomes "is fraud's timing
 * further from legitimate traffic than chance would explain".
 */
export function divergenceUnderNull(
  reference: readonly string[],
  sampleSize: number,
  percentile = 0.95,
  draws = 200,
): number {
  if (reference.length === 0 || sampleSize === 0) return 0;
  let state = 0x9e3779b9;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const referenceCounts = counted(reference, (value) => value);
  const divergences: number[] = [];
  for (let draw = 0; draw < draws; draw += 1) {
    const sample: string[] = [];
    for (let i = 0; i < sampleSize; i += 1) {
      sample.push(reference[Math.floor(next() * reference.length)] as string);
    }
    divergences.push(
      categoricalDivergence(
        counted(sample, (v) => v),
        referenceCounts,
      ),
    );
  }
  return quantile(
    divergences.sort((a, b) => a - b),
    percentile,
  );
}
