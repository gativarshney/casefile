/**
 * Two semantically-equal payloads serialising differently makes replay report false
 * integrity failures; two different payloads serialising identically lets tampering
 * through. Both directions are pinned here.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CanonicalisationError,
  canonicalBytes,
  canonicalJson,
  quantise,
} from "../src/canon/canonical.js";

const canonicalValue = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constant(null),
    fc.boolean(),
    fc.integer({ min: -(2 ** 40), max: 2 ** 40 }),
    fc.string({ maxLength: 30 }),
    fc.array(tie("value"), { maxLength: 5 }),
    fc.dictionary(fc.string({ maxLength: 15 }), tie("value"), { maxKeys: 5 }),
  ),
})).value;

describe("canonical form", () => {
  it("is unaffected by key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("is unaffected by key order at any depth", () => {
    const left = { outer: { z: [{ b: 1, a: 2 }] } };
    const right = { outer: { z: [{ a: 2, b: 1 }] } };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
  });

  it("emits no insignificant whitespace", () => {
    expect(canonicalJson({ a: [1, 2], b: { c: 3 } })).toBe('{"a":[1,2],"b":{"c":3}}');
  });

  it("preserves non-ASCII rather than escaping it", () => {
    expect(canonicalJson({ merchant: "Café" })).toBe('{"merchant":"Café"}');
  });

  it("always emits parseable JSON", () => {
    const payload = { a: 1, b: [null, true, "x"], c: { d: -5 } };
    expect(JSON.parse(canonicalJson(payload))).toEqual(payload);
  });

  it("normalises negative zero", () => {
    expect(canonicalJson({ n: -0 })).toBe(canonicalJson({ n: 0 }));
  });

  it("distinguishes a number from its string form", () => {
    expect(canonicalJson({ amount: 100 })).not.toBe(canonicalJson({ amount: "100" }));
  });

  it("distinguishes a boolean from a number", () => {
    expect(canonicalJson({ flag: true })).not.toBe(canonicalJson({ flag: 1 }));
  });

  it("round-trips any canonicalisable value", () => {
    fc.assert(
      fc.property(canonicalValue, (value) => {
        expect(JSON.parse(new TextDecoder().decode(canonicalBytes(value)))).toEqual(value);
      }),
    );
  });

  it("is stable across repeated calls", () => {
    fc.assert(
      fc.property(canonicalValue, (value) => {
        expect(canonicalJson(value)).toBe(canonicalJson(value));
      }),
    );
  });

  it("is invariant to the insertion order of object keys", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 10 }), fc.integer(), { minKeys: 2, maxKeys: 8 }),
        (record) => {
          const shuffled = Object.fromEntries(Object.entries(record).reverse());
          expect(canonicalJson(shuffled)).toBe(canonicalJson(record));
        },
      ),
    );
  });
});

describe("the numerical boundary", () => {
  it.each([
    ["a float", 12.5],
    ["a tiny float", 1e-9],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalJson({ amount: value })).toThrow(CanonicalisationError);
  });

  it("names the offending path so the call site is findable", () => {
    expect(() => canonicalJson({ txn: { amount: 12.5 } })).toThrow(/txn\.amount/);
  });

  it("names the offending index inside an array", () => {
    expect(() => canonicalJson({ amounts: [1, 2, 3.5] })).toThrow(/amounts\[2\]/);
  });

  it("suggests the sanctioned alternatives in the message", () => {
    expect(() => canonicalJson(1.5)).toThrow(/minor units|basis points|quantise/);
  });

  it("no float survives anywhere in a nested structure", () => {
    fc.assert(
      fc.property(fc.double({ noInteger: true, noNaN: true, min: -1e6, max: 1e6 }), (someFloat) => {
        expect(() => canonicalJson({ a: { b: [{ c: someFloat }] } })).toThrow(
          CanonicalisationError,
        );
      }),
    );
  });

  it("accepts every integer-valued number", () => {
    fc.assert(
      fc.property(fc.integer({ min: -(2 ** 45), max: 2 ** 45 }), (value) => {
        expect(() => canonicalJson({ amountMinor: value })).not.toThrow();
      }),
    );
  });

  it("rejects integers beyond exact representation", () => {
    expect(() => canonicalJson({ n: Number.MAX_SAFE_INTEGER + 2 })).toThrow(
      /exactly-representable/,
    );
  });
});

describe("rejected types", () => {
  it.each([
    ["undefined", undefined],
    ["a bigint", 10n],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a Set", new Set()],
    ["a function", () => 1],
    ["a symbol", Symbol("x")],
    ["a class instance", new (class Thing {})()],
  ])("rejects %s rather than guessing an encoding", (_label, value) => {
    expect(() => canonicalJson({ field: value })).toThrow(CanonicalisationError);
  });

  it("rejects undefined as an object value", () => {
    expect(() => canonicalJson({ a: 1, b: undefined })).toThrow(CanonicalisationError);
  });
});

describe("quantise", () => {
  it("produces a fixed-precision decimal string", () => {
    expect(quantise(0.123456789)).toBe("0.123457");
  });

  it("always emits exactly the requested number of places", () => {
    expect(quantise(0.5)).toBe("0.500000");
    expect(quantise(1)).toBe("1.000000");
    expect(quantise(0)).toBe("0.000000");
  });

  it("collapses values that differ below the precision", () => {
    expect(quantise(0.1234561)).toBe(quantise(0.1234559));
  });

  it("rounds symmetrically about zero", () => {
    expect(quantise(-0.123456789)).toBe("-0.123457");
  });

  it("has a single representation for zero", () => {
    expect(quantise(-0)).toBe("0.000000");
    expect(quantise(-1e-12)).toBe("0.000000");
  });

  it("honours a custom precision", () => {
    expect(quantise(0.5, 2)).toBe("0.50");
    expect(quantise(3.7, 0)).toBe("4");
  });

  it("rejects non-finite input", () => {
    expect(() => quantise(Number.NaN)).toThrow(CanonicalisationError);
    expect(() => quantise(Number.POSITIVE_INFINITY)).toThrow(CanonicalisationError);
  });

  it("rejects a nonsensical precision", () => {
    expect(() => quantise(1, -1)).toThrow(/out of range/);
    expect(() => quantise(1, 99)).toThrow(/out of range/);
  });

  it("its output is always canonicalisable — this is the whole point", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, min: -1e9, max: 1e9 }), (value) => {
        const frozen = quantise(value);
        expect(() => canonicalJson({ score: frozen })).not.toThrow();
        expect(typeof frozen).toBe("string");
      }),
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, min: -1e6, max: 1e6 }), (value) => {
        expect(quantise(value)).toBe(quantise(value));
      }),
    );
  });

  it("is monotonic — a larger score never quantises to a smaller string value", () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: true, min: -1e6, max: 1e6 }),
        fc.double({ noNaN: true, min: -1e6, max: 1e6 }),
        (a, b) => {
          if (a <= b) expect(Number(quantise(a))).toBeLessThanOrEqual(Number(quantise(b)));
        },
      ),
    );
  });
});
