import { createHash } from "node:crypto";

/**
 * Streams are derived from a seed plus a path naming what is being generated, rather
 * than drawn from one shared generator. With a shared stream, adding an actor shifts
 * every subsequent draw, so two worlds differing by one parameter are not comparable
 * and any ablation is confounded. Path derivation makes each actor's behaviour depend
 * only on its own identity and the seed.
 */
export interface RandomStream {
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probabilityBps: number): boolean;
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  normal(): number;
  /** Right-skewed integer draw; real ticket sizes are lognormal, not uniform. */
  lognormalInt(median: number, sigma: number, floor?: number): number;
  shuffle<T>(items: readonly T[]): T[];
}

function seedFrom(seed: number, path: readonly (string | number)[]): number {
  const material = [String(seed), ...path.map(String)].join("");
  return createHash("sha256").update(material).digest().readUInt32BE(0);
}

export function stream(seed: number, ...path: (string | number)[]): RandomStream {
  let state = seedFrom(seed, path);
  // mulberry32, written out rather than imported so reproducibility does not depend on
  // a runtime's Math.random implementation or a dependency's version.
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const self: RandomStream = {
    next,
    int: (minInclusive, maxInclusive) =>
      minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (probabilityBps) => next() * 10_000 < probabilityBps,
    weighted: <T>(entries: readonly (readonly [T, number])[]): T => {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      let threshold = next() * total;
      for (const [value, weight] of entries) {
        threshold -= weight;
        if (threshold < 0) return value;
      }
      return (entries[entries.length - 1] as readonly [T, number])[0];
    },
    normal: () => {
      // Box-Muller; the guard keeps log() finite.
      const u = Math.max(next(), 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
    lognormalInt: (median, sigma, floor = 100) =>
      Math.max(floor, Math.round(median * Math.exp(sigma * self.normal()))),
    shuffle: <T>(items: readonly T[]): T[] => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
      }
      return copy;
    },
  };
  return self;
}
