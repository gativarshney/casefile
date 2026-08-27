import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseSync from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CARDS,
  CUSTOMERS,
  type Customer,
  MERCHANTS,
  type Merchant,
  recordHash,
  TRANSACTIONS,
  type Transaction,
} from "../src/world/schema.js";
import {
  type DatasetManifest,
  IntegrityError,
  StoreError,
  WorldReader,
  WorldStore,
} from "../src/world/store.js";

const BASE_MS = 1_736_121_600_000;

const customer = (index: number): Customer => ({
  customerId: `cust_${String(index).padStart(4, "0")}`,
  signupAtMs: BASE_MS + index * 1_000,
  homeCountry: "IN",
  homeCity: "Bengaluru",
  emailDomain: "example.com",
  kycLevel: index % 3,
});

const merchant = (index: number): Merchant => ({
  merchantId: `mer_${String(index).padStart(4, "0")}`,
  name: `Merchant ${index}`,
  mcc: "5732",
  category: "electronics",
  country: "IN",
  avgTicketMinor: 250_000,
  baselineDisputeRateBps: 45,
  onboardedAtMs: BASE_MS,
});

const transaction = (index: number, amountMinor = 150_000): Transaction => ({
  txnId: `txn_${String(index).padStart(6, "0")}`,
  customerId: "cust_0000",
  cardId: "card_0000",
  merchantId: "mer_0000",
  sessionId: "ses_0000",
  atMs: BASE_MS + index * 60_000,
  amountMinor,
  currency: "INR",
  status: "captured",
  declineReason: null,
  avsResult: "pass",
  cvvResult: "pass",
  threeDsResult: "pass",
  shippingCity: null,
  description: "Order 4471",
});

let directory: string;
let worldPath: string;
let manifest: DatasetManifest;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "casefile-"));
  worldPath = join(directory, "world.db");
  const store = new WorldStore(worldPath);
  store.insert(
    CUSTOMERS,
    Array.from({ length: 5 }, (_, i) => customer(i)),
  );
  store.insert(
    MERCHANTS,
    Array.from({ length: 3 }, (_, i) => merchant(i)),
  );
  store.insert(
    TRANSACTIONS,
    Array.from({ length: 20 }, (_, i) => transaction(i)),
  );
  manifest = store.manifest({ seed: 7 });
  store.close();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function withReader<T>(run: (reader: WorldReader) => T): T {
  const reader = new WorldReader(worldPath);
  try {
    return run(reader);
  } finally {
    reader.close();
  }
}

function rawSql(sql: string, params: readonly unknown[] = []): void {
  const db = new DatabaseSync(worldPath);
  db.prepare(sql).run(...(params as never[]));
  db.close();
}

describe("round trip", () => {
  it("returns records identical to what was written", () => {
    expect(withReader((r) => r.get(CUSTOMERS, "cust_0003"))).toEqual(customer(3));
  });

  it("preserves enum values", () => {
    expect(withReader((r) => r.get(MERCHANTS, "mer_0001"))?.category).toBe("electronics");
  });

  it("preserves nulls in optional fields", () => {
    const store = new WorldStore(worldPath);
    store.insert(TRANSACTIONS, [{ ...transaction(0), customerId: null }]);
    store.close();
    expect(withReader((r) => r.get(TRANSACTIONS, "txn_000000"))?.customerId).toBeNull();
  });

  it("orders results by primary key", () => {
    const ids = withReader((r) => r.all(TRANSACTIONS)).map((t) => t.txnId);
    expect(ids).toEqual([...ids].sort());
  });

  it("returns undefined for a missing key", () => {
    expect(withReader((r) => r.get(CUSTOMERS, "cust_9999"))).toBeUndefined();
  });

  it("rejects a record that fails its schema", () => {
    const store = new WorldStore(join(directory, "other.db"));
    expect(() => store.insert(CUSTOMERS, [{ ...customer(0), kycLevel: 9 }])).toThrow();
    store.close();
  });

  it("rejects a non-integer amount, keeping floats out of the store", () => {
    const store = new WorldStore(join(directory, "other.db"));
    expect(() => store.insert(TRANSACTIONS, [{ ...transaction(0), amountMinor: 1.5 }])).toThrow();
    store.close();
  });
});

describe("the reader is read-only", () => {
  it("refuses writes at the SQLite level", () => {
    expect(() =>
      withReader((r) => {
        (r as unknown as { db: { exec(sql: string): void } }).db.exec(
          "UPDATE transactions SET amount_minor = 1",
        );
      }),
    ).toThrow();
  });

  it("explains how to create a world that does not exist", () => {
    expect(() => new WorldReader(join(directory, "absent.db"))).toThrow(StoreError);
    expect(() => new WorldReader(join(directory, "absent.db"))).toThrow(/casefile generate/);
  });
});

describe("manifest integrity", () => {
  it("an untouched world verifies", () => {
    expect(() => withReader((r) => r.verifyAgainstManifest(manifest))).not.toThrow();
  });

  it("detects a modified field", () => {
    rawSql("UPDATE transactions SET amountMinor = 999999 WHERE txnId = ?", ["txn_000004"]);
    expect(() => withReader((r) => r.verifyAgainstManifest(manifest))).toThrow(IntegrityError);
  });

  it("names the table that changed", () => {
    rawSql("UPDATE transactions SET amountMinor = 999999 WHERE txnId = ?", ["txn_000004"]);
    try {
      withReader((r) => r.verifyAgainstManifest(manifest));
      expect.unreachable("expected an integrity failure");
    } catch (error) {
      expect((error as IntegrityError).subject).toBe("transactions");
    }
  });

  it("reports both the expected and the actual root", () => {
    rawSql("UPDATE transactions SET amountMinor = 1 WHERE txnId = ?", ["txn_000004"]);
    try {
      withReader((r) => r.verifyAgainstManifest(manifest));
      expect.unreachable("expected an integrity failure");
    } catch (error) {
      const failure = error as IntegrityError;
      expect(failure.expected).toContain("sha256:");
      expect(failure.expected).not.toBe(failure.actual);
    }
  });

  it("detects a modified field even when the stored digest is updated to match", () => {
    // The record_hash column is not trusted: whoever can rewrite a row can rewrite the
    // digest beside it, so a fully self-consistent forgery must still fail.
    const forged = { ...transaction(4), amountMinor: 999_999 };
    rawSql("UPDATE transactions SET amountMinor = ?, record_hash = ? WHERE txnId = ?", [
      forged.amountMinor,
      recordHash(TRANSACTIONS, forged),
      forged.txnId,
    ]);

    expect(() => withReader((r) => r.verifyAgainstManifest(manifest))).toThrow(IntegrityError);
  });

  it("detects a deleted row", () => {
    rawSql("DELETE FROM transactions WHERE txnId = ?", ["txn_000004"]);
    expect(() => withReader((r) => r.verifyAgainstManifest(manifest))).toThrow(/20 rows/);
  });

  it("detects an inserted row", () => {
    const extra = transaction(999);
    const columns = TRANSACTIONS.columns;
    rawSql(
      `INSERT INTO transactions (${[...columns, "record_hash"].join(", ")}) VALUES (${columns
        .map(() => "?")
        .concat("?")
        .join(", ")})`,
      [...columns.map((name) => (extra as Record<string, unknown>)[name]), "sha256:forged"],
    );
    expect(() => withReader((r) => r.verifyAgainstManifest(manifest))).toThrow(IntegrityError);
  });
});

describe("determinism", () => {
  function rootOf(name: string, build: (store: WorldStore) => void): string {
    const store = new WorldStore(join(directory, name));
    build(store);
    const root = store.manifest().worldRoot;
    store.close();
    return root;
  }

  it("identical content produces an identical world root", () => {
    const build = (store: WorldStore) => {
      store.insert(
        CUSTOMERS,
        Array.from({ length: 5 }, (_, i) => customer(i)),
      );
      store.insert(
        TRANSACTIONS,
        Array.from({ length: 10 }, (_, i) => transaction(i)),
      );
    };
    expect(rootOf("a.db", build)).toBe(rootOf("b.db", build));
  });

  it("insertion order does not affect the world root", () => {
    const forward = rootOf("a.db", (s) =>
      s.insert(
        CUSTOMERS,
        Array.from({ length: 5 }, (_, i) => customer(i)),
      ),
    );
    const reverse = rootOf("b.db", (s) =>
      s.insert(
        CUSTOMERS,
        Array.from({ length: 5 }, (_, i) => customer(4 - i)),
      ),
    );
    expect(forward).toBe(reverse);
  });

  it("a one-paisa difference moves the world root", () => {
    const original = rootOf("a.db", (s) =>
      s.insert(
        TRANSACTIONS,
        Array.from({ length: 10 }, (_, i) => transaction(i)),
      ),
    );
    const altered = rootOf("b.db", (s) =>
      s.insert(TRANSACTIONS, [
        ...Array.from({ length: 9 }, (_, i) => transaction(i)),
        transaction(9, 150_001),
      ]),
    );
    expect(original).not.toBe(altered);
  });

  it("an empty table still contributes to the world root", () => {
    const empty = rootOf("a.db", () => {});
    const populated = rootOf("b.db", (s) => s.insert(CARDS, []));
    expect(empty).toBe(populated);
    expect(empty).toMatch(/^sha256:/);
  });
});
