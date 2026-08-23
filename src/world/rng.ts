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
  return {
    next,
    int: (minInclusive, maxInclusive) =>
      minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (probabilityBps) => next() * 10_000 < probabilityBps,
  };
}
