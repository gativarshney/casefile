/**
 * The payment world: the source records Casefile investigates.
 *
 * Two constraints govern what may live here.
 *
 * Nothing may reveal which simulated actor produced a record or whether it is fraud —
 * ground truth lives in a physically separate store the investigation path cannot
 * reach. And nothing may exist that a real acquirer would not hold at authorisation
 * time, since a field available only in hindsight makes the evaluation clairvoyant
 * rather than honest.
 *
 * Only the records the first end-to-end slice needs are defined so far.
 */
import { z } from "zod";
import { digest } from "../canon/hash.js";

export const MinorUnits = z.int().nonnegative();

/** UTC. */
export const EpochMs = z.int();

/** ISO 3166-1 alpha-2. */
export const CountryCode = z.string().length(2);

export const CURRENCY = "INR";

export const MerchantCategory = z.enum([
  "gift_cards",
  "wallet_topup",
  "electronics",
  "fashion",
  "grocery",
  "travel",
  "food_delivery",
  "utilities",
  "gaming",
  "subscription",
]);
export type MerchantCategory = z.infer<typeof MerchantCategory>;

export const TransactionStatus = z.enum(["authorized", "captured", "declined", "refunded"]);
export type TransactionStatus = z.infer<typeof TransactionStatus>;

/**
 * `unavailable` is a distinct outcome from `pass`. A verifier that reads a missing
 * check as a clean one is defeated by suppressing the check.
 */
export const CheckResult = z.enum(["pass", "fail", "unavailable", "not_requested"]);
export type CheckResult = z.infer<typeof CheckResult>;

export const Customer = z.object({
  customerId: z.string().min(1),
  signupAtMs: EpochMs,
  homeCountry: CountryCode,
  homeCity: z.string().min(1),
  emailDomain: z.string().min(1),
  /** 0 = email only, 1 = phone verified, 2 = full KYC. */
  kycLevel: z.int().min(0).max(2),
});
export type Customer = z.infer<typeof Customer>;

export const Merchant = z.object({
  merchantId: z.string().min(1),
  name: z.string().min(1),
  mcc: z.string().length(4),
  category: MerchantCategory,
  country: CountryCode,
  avgTicketMinor: MinorUnits.positive(),
  /** Some legitimate merchants simply run high; this is context, not a signal. */
  baselineDisputeRateBps: z.int().min(0).max(10_000),
  onboardedAtMs: EpochMs,
});
export type Merchant = z.infer<typeof Merchant>;

export const Card = z.object({
  cardId: z.string().min(1),
  customerId: z.string().min(1),
  bin: z.string().length(6),
  last4: z.string().length(4),
  brand: z.enum(["visa", "mastercard", "rupay", "amex"]),
  funding: z.enum(["credit", "debit", "prepaid"]),
  issuerCountry: CountryCode,
  addedAtMs: EpochMs,
});
export type Card = z.infer<typeof Card>;

export const Transaction = z.object({
  txnId: z.string().min(1),
  /** Null before authentication, which is where card testing largely happens. */
  customerId: z.string().min(1).nullable(),
  cardId: z.string().min(1),
  merchantId: z.string().min(1),
  atMs: EpochMs,
  amountMinor: MinorUnits.positive(),
  currency: z.literal(CURRENCY),
  status: TransactionStatus,
  avsResult: CheckResult,
  cvvResult: CheckResult,
  threeDsResult: CheckResult,
  /** Attacker-controlled in production: never a signal, never reaches a prompt raw. */
  description: z.string(),
});
export type Transaction = z.infer<typeof Transaction>;

/**
 * Record types with the payload type erased, for heterogeneous collections such as
 * "every table in the world". Erasure goes through concrete methods rather than a cast
 * so rows stay schema-validated on the way out of SQLite.
 */
export interface ErasedRecordType {
  readonly table: string;
  readonly primaryKey: string;
  readonly columns: readonly string[];
  /** SQLite has no boolean type; these columns round-trip through integers. */
  readonly booleanColumns: readonly string[];
  parseUnknown(row: unknown): Record<string, unknown>;
  hashUnknown(record: Record<string, unknown>): string;
}

export interface RecordType<T> extends ErasedRecordType {
  readonly primaryKey: keyof T & string;
  readonly schema: z.ZodType<T>;
  parse(row: unknown): T;
}

function defineRecordType<T extends Record<string, unknown>>(
  table: string,
  primaryKey: keyof T & string,
  schema: z.ZodObject<z.ZodRawShape>,
): RecordType<T> {
  const shape = schema.shape;
  const columns = Object.keys(shape);
  return {
    table,
    primaryKey,
    columns,
    booleanColumns: columns.filter((name) => unwrapType(shape[name]) === "boolean"),
    schema: schema as unknown as z.ZodType<T>,
    parse: (row) => schema.parse(row) as T,
    parseUnknown: (row) => schema.parse(row) as Record<string, unknown>,
    hashUnknown: (record) =>
      digest({ table, id: String(record[primaryKey]), body: record as never }),
  };
}

/** Resolves the underlying type name through optional/nullable/default wrappers. */
function unwrapType(field: unknown): string | undefined {
  let current: unknown = field;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    const def = (current as { def?: { type?: string; innerType?: unknown } }).def;
    if (!def) return undefined;
    if (def.innerType) {
      current = def.innerType;
      continue;
    }
    return def.type;
  }
  return undefined;
}

export const CUSTOMERS = defineRecordType<Customer>("customers", "customerId", Customer);
export const MERCHANTS = defineRecordType<Merchant>("merchants", "merchantId", Merchant);
export const CARDS = defineRecordType<Card>("cards", "cardId", Card);
export const TRANSACTIONS = defineRecordType<Transaction>("transactions", "txnId", Transaction);

/** Order fixes the leaf ordering of the dataset Merkle tree; changing it moves the root. */
export const WORLD_RECORD_TYPES: readonly ErasedRecordType[] = [
  CUSTOMERS,
  MERCHANTS,
  CARDS,
  TRANSACTIONS,
];

/**
 * Table and primary key are mixed in so an identical body in two tables cannot collide.
 *
 * Always computed from live fields. A digest stored beside the data it protects proves
 * nothing: whoever can rewrite the row can rewrite that column too.
 */
export function recordHash(type: ErasedRecordType, record: Record<string, unknown>): string {
  return type.hashUnknown(record);
}
