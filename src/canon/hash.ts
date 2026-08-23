import { createHash } from "node:crypto";
import { canonicalBytes } from "./canonical.js";

export const HASH_ALGORITHM = "sha256";

/**
 * An algorithm-prefixed hex digest, e.g. `sha256:9f86d0…`. The prefix is part of the
 * sealed value so a future hash migration cannot produce digests that look comparable
 * to old ones.
 */
export type Digest = string;

export function digestBytes(payload: Uint8Array): Digest {
  return `${HASH_ALGORITHM}:${createHash(HASH_ALGORITHM).update(payload).digest("hex")}`;
}

export function digest(value: unknown): Digest {
  return digestBytes(canonicalBytes(value));
}

/**
 * Binary Merkle root over an ordered list of leaf digests.
 *
 * An odd node is **promoted** to the next level, never duplicated. Duplicating it — the
 * construction Bitcoin originally used — makes `[a, b, c]` and `[a, b, c, c]` produce
 * the same root (CVE-2012-2459), so a table could gain a duplicated final row without
 * the dataset root moving. Promotion has no such collision.
 *
 * The empty list hashes to the digest of the empty byte string, so an empty table is
 * still committed to rather than silently skipped.
 */
export function merkleRoot(leafDigests: readonly Digest[]): Digest {
  if (leafDigests.length === 0) return digestBytes(new Uint8Array());

  let level: Digest[] = [...leafDigests];
  while (level.length > 1) {
    const parents: Digest[] = [];
    let index = 0;
    for (; index + 1 < level.length; index += 2) {
      const left = level[index] as Digest;
      const right = level[index + 1] as Digest;
      // The separator is load-bearing: without it ("ab","c") and ("a","bc") collide.
      parents.push(digestBytes(new TextEncoder().encode(`${left}|${right}`)));
    }
    if (index < level.length) parents.push(level[index] as Digest);
    level = parents;
  }
  return level[0] as Digest;
}

/**
 * Each link commits to both the running chain state and the new value, so steps cannot
 * be reordered, excised or inserted without moving the head.
 */
export function chain(previous: Digest | null, value: unknown): Digest {
  return digest({ prev: previous, value: value as never });
}

/** Intermediate links are retained so a failing replay can report which step diverged. */
export function chainAll(values: readonly unknown[]): { links: Digest[]; head: Digest | null } {
  const links: Digest[] = [];
  let head: Digest | null = null;
  for (const value of values) {
    head = chain(head, value);
    links.push(head);
  }
  return { links, head };
}
