import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chain, chainAll, digest, digestBytes, merkleRoot } from "../src/canon/hash.js";

const leaf = (n: number) => digest({ i: n });
const leaves = (count: number) => Array.from({ length: count }, (_, i) => leaf(i));

describe("digest", () => {
  it("is algorithm-prefixed", () => {
    expect(digest({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("matches an independently computed SHA-256", () => {
    // Pinned against `printf '{"a":1}' | sha256sum`, so a change in canonical shape
    // fails here rather than silently reissuing every digest already published.
    expect(digest({ a: 1 })).toBe(
      "sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
  });

  it("agrees with hashing the canonical bytes directly", () => {
    expect(digest({ a: 1 })).toBe(digestBytes(new TextEncoder().encode('{"a":1}')));
  });

  it("ignores key order, because it hashes the canonical form", () => {
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
  });

  it("separates values that differ by one unit", () => {
    expect(digest({ amountMinor: 100 })).not.toBe(digest({ amountMinor: 101 }));
  });

  it("separates a number from its string form", () => {
    expect(digest({ amountMinor: 100 })).not.toBe(digest({ amountMinor: "100" }));
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        try {
          expect(digest(value)).toBe(digest(value));
        } catch {
          expect(() => digest(value)).toThrow();
        }
      }),
    );
  });
});

describe("merkle root", () => {
  it("has a defined root for an empty list", () => {
    expect(merkleRoot([])).toMatch(/^sha256:/);
  });

  it("returns the single leaf unchanged", () => {
    expect(merkleRoot([leaf(0)])).toBe(leaf(0));
  });

  it("is order-significant", () => {
    expect(merkleRoot([leaf(0), leaf(1)])).not.toBe(merkleRoot([leaf(1), leaf(0)]));
  });

  it("moves when any leaf changes", () => {
    const original = leaves(7);
    const mutated = [...original];
    mutated[3] = leaf(99);
    expect(merkleRoot(original)).not.toBe(merkleRoot(mutated));
  });

  it("moves when a leaf is appended", () => {
    expect(merkleRoot(leaves(5))).not.toBe(merkleRoot(leaves(6)));
  });

  it("moves when a leaf is removed", () => {
    expect(merkleRoot(leaves(5))).not.toBe(merkleRoot(leaves(4)));
  });

  it("is deterministic", () => {
    const set = leaves(9);
    expect(merkleRoot(set)).toBe(merkleRoot([...set]));
  });

  it("distinguishes every distinct prefix of a growing table", () => {
    const roots = new Set(Array.from({ length: 20 }, (_, n) => merkleRoot(leaves(n))));
    expect(roots.size).toBe(20);
  });

  describe("odd-leaf promotion (CVE-2012-2459 regression)", () => {
    it("a three-leaf list does not collide with the same list plus a duplicated tail", () => {
      const three = leaves(3);
      const withDuplicatedTail = [...three, three[2] as string];
      expect(merkleRoot(three)).not.toBe(merkleRoot(withDuplicatedTail));
    });

    it("holds for every odd list length", () => {
      for (let size = 1; size <= 15; size += 2) {
        const odd = leaves(size);
        const duplicated = [...odd, odd[size - 1] as string];
        expect(merkleRoot(odd), `size ${size}`).not.toBe(merkleRoot(duplicated));
      }
    });

    it("holds at deeper levels, not only the leaf level", () => {
      // Six leaves make three level-1 nodes, exercising promotion above the leaf level.
      const six = leaves(6);
      const seven = [...six, six[5] as string];
      expect(merkleRoot(six)).not.toBe(merkleRoot(seven));
    });

    it("the duplicating variant DOES collide — proving this test discriminates", () => {
      // The vulnerable construction, duplicating the odd node instead of promoting it.
      const duplicatingRoot = (input: readonly string[]): string => {
        if (input.length === 0) return digestBytes(new Uint8Array());
        let level = [...input];
        while (level.length > 1) {
          if (level.length % 2 === 1) level.push(level[level.length - 1] as string);
          const parents: string[] = [];
          for (let i = 0; i < level.length; i += 2) {
            parents.push(digestBytes(new TextEncoder().encode(`${level[i]}|${level[i + 1]}`)));
          }
          level = parents;
        }
        return level[0] as string;
      };

      const three = leaves(3);
      const withDuplicatedTail = [...three, three[2] as string];

      expect(duplicatingRoot(three)).toBe(duplicatingRoot(withDuplicatedTail));
      expect(merkleRoot(three)).not.toBe(merkleRoot(withDuplicatedTail));
    });

    it("no list collides with any other, across many shapes", () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 24 }),
          fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 24 }),
          (a, b) => {
            const rootA = merkleRoot(a.map(leaf));
            const rootB = merkleRoot(b.map(leaf));
            if (rootA === rootB) expect(a).toEqual(b);
          },
        ),
        { numRuns: 500 },
      );
    });
  });
});

describe("hash chain", () => {
  it("commits to prior state", () => {
    const first = chain(null, { step: "collect" });
    expect(chain(first, { step: "verify" })).not.toBe(chain(null, { step: "verify" }));
  });

  it("detects reordering", () => {
    const forward = chain(chain(null, { s: 1 }), { s: 2 });
    const backward = chain(chain(null, { s: 2 }), { s: 1 });
    expect(forward).not.toBe(backward);
  });

  it("detects an excised step", () => {
    const full = chain(chain(chain(null, { s: 1 }), { s: 2 }), { s: 3 });
    const excised = chain(chain(null, { s: 1 }), { s: 3 });
    expect(full).not.toBe(excised);
  });

  it("detects an inserted step", () => {
    const original = chainAll([{ s: 1 }, { s: 2 }]).head;
    const inserted = chainAll([{ s: 1 }, { s: 9 }, { s: 2 }]).head;
    expect(original).not.toBe(inserted);
  });

  it("detects a modified step", () => {
    const original = chainAll([{ s: 1 }, { s: 2 }, { s: 3 }]).head;
    const modified = chainAll([{ s: 1 }, { s: 2 }, { s: 4 }]).head;
    expect(original).not.toBe(modified);
  });

  it("retains intermediate links so a divergence can be located", () => {
    const { links, head } = chainAll([{ s: 1 }, { s: 2 }, { s: 3 }]);
    expect(links).toHaveLength(3);
    expect(links[2]).toBe(head);
    expect(links[0]).toBe(chain(null, { s: 1 }));
  });

  it("an empty sequence has a null head", () => {
    expect(chainAll([]).head).toBeNull();
  });

  it("any single-step mutation changes the head", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 1, maxLength: 10 }),
        fc.nat(),
        fc.integer({ min: 0, max: 100 }),
        (steps, rawIndex, replacement) => {
          const index = rawIndex % steps.length;
          if (steps[index] === replacement) return;
          const mutated = [...steps];
          mutated[index] = replacement;
          const before = chainAll(steps.map((s) => ({ s }))).head;
          const after = chainAll(mutated.map((s) => ({ s }))).head;
          expect(before).not.toBe(after);
        },
      ),
    );
  });
});
