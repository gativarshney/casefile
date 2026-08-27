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
 * Devices and IP addresses are reachable only through sessions, never denormalised
 * onto transactions: probes must traverse the entity graph the way an acquirer's
 * systems actually would.
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
 * The composition of decline reasons carries more signal than any single decline: a
 * wall of `invalid_card` across many BINs is enumeration, while `insufficient_funds`
 * is ordinary life.
 */
export const DeclineReason = z.enum([
  "insufficient_funds",
  "invalid_card",
  "expired_card",
  "do_not_honour",
  "suspected_fraud",
  "authentication_failed",
]);
export type DeclineReason = z.infer<typeof DeclineReason>;

/**
 * `unavailable` is a distinct outcome from `pass`. A verifier that reads a missing
 * check as a clean one is defeated by suppressing the check.
 */
export const CheckResult = z.enum(["pass", "fail", "unavailable", "not_requested"]);
export type CheckResult = z.infer<typeof CheckResult>;

export const Channel = z.enum(["web", "mobile_app", "recurring"]);
export type Channel = z.infer<typeof Channel>;

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
  /**
   * Set when this card replaced an earlier one for the same customer. A reissue changes
   * the BIN and the instrument age at once, which otherwise reads as a brand-new card
   * on an established account.
   */
  replacesCardId: z.string().min(1).nullable(),
});
export type Card = z.infer<typeof Card>;

export const Device = z.object({
  deviceId: z.string().min(1),
  /** Null when fingerprinting failed — routine in production, and never exculpatory. */
  fingerprint: z.string().min(1).nullable(),
  osFamily: z.string().min(1),
  browserFamily: z.string().min(1),
  firstSeenAtMs: EpochMs,
  /** Noisy on purpose: privacy-hardened legitimate browsers trip this too. */
  automationSignals: z.boolean(),
});
export type Device = z.infer<typeof Device>;

export const IpAddress = z.object({
  ipId: z.string().min(1),
  address: z.string().min(1),
  asn: z.int().positive(),
  asnOrg: z.string().min(1),
  /** Null when geolocation is unavailable — common for mobile carriers. */
  country: CountryCode.nullable(),
  city: z.string().min(1).nullable(),
  isDatacenter: z.boolean(),
  /** Third-party VPN classification, wrong often enough to matter. */
  vpnSuspected: z.boolean(),
});
export type IpAddress = z.infer<typeof IpAddress>;

export const Session = z.object({
  sessionId: z.string().min(1),
  /** Null before authentication — card testing largely happens there. */
  customerId: z.string().min(1).nullable(),
  deviceId: z.string().min(1),
  ipId: z.string().min(1),
  startedAtMs: EpochMs,
  endedAtMs: EpochMs,
  channel: Channel,
});
export type Session = z.infer<typeof Session>;

export const AuthEvent = z.object({
  authEventId: z.string().min(1),
  sessionId: z.string().min(1),
  customerId: z.string().min(1).nullable(),
  kind: z.enum(["login", "otp_challenge", "three_ds_challenge", "password_reset"]),
  outcome: z.enum(["success", "failure", "abandoned"]),
  atMs: EpochMs,
});
export type AuthEvent = z.infer<typeof AuthEvent>;

/**
 * Only digests of the old and new values are retained. Contact-detail churn just before
 * a high-value purchase is one of the strongest takeover signals, and it does not
 * require knowing what the values were.
 */
export const ProfileChange = z.object({
  changeId: z.string().min(1),
  customerId: z.string().min(1),
  sessionId: z.string().min(1),
  field: z.enum(["email", "phone", "shipping_address", "password"]),
  atMs: EpochMs,
  oldValueDigest: z.string().min(1),
  newValueDigest: z.string().min(1),
});
export type ProfileChange = z.infer<typeof ProfileChange>;

export const Transaction = z.object({
  txnId: z.string().min(1),
  customerId: z.string().min(1).nullable(),
  cardId: z.string().min(1),
  merchantId: z.string().min(1),
  sessionId: z.string().min(1),
  atMs: EpochMs,
  amountMinor: MinorUnits.positive(),
  currency: z.literal(CURRENCY),
  status: TransactionStatus,
  declineReason: DeclineReason.nullable(),
  avsResult: CheckResult,
  cvvResult: CheckResult,
  threeDsResult: CheckResult,
  shippingCity: z.string().min(1).nullable(),
  /** Attacker-controlled in production: never a signal, never reaches a prompt raw. */
  description: z.string(),
});
export type Transaction = z.infer<typeof Transaction>;

/**
 * Disputes land weeks after their transaction. The verifier may consult disputes on
 * *prior* transactions as history, but never the dispute belonging to the transaction
 * under investigation — that would be reading the future.
 */
export const Dispute = z.object({
  disputeId: z.string().min(1),
  txnId: z.string().min(1),
  openedAtMs: EpochMs,
  category: z.enum([
    "unauthorised",
    "not_received",
    "not_as_described",
    "duplicate",
    "subscription_cancelled",
  ]),
  outcome: z.enum(["pending", "won", "lost"]),
});
export type Dispute = z.infer<typeof Dispute>;

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

export function defineRecordType<T extends Record<string, unknown>>(
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
export const DEVICES = defineRecordType<Device>("devices", "deviceId", Device);
export const IP_ADDRESSES = defineRecordType<IpAddress>("ip_addresses", "ipId", IpAddress);
export const SESSIONS = defineRecordType<Session>("sessions", "sessionId", Session);
export const AUTH_EVENTS = defineRecordType<AuthEvent>("auth_events", "authEventId", AuthEvent);
export const PROFILE_CHANGES = defineRecordType<ProfileChange>(
  "profile_changes",
  "changeId",
  ProfileChange,
);
export const TRANSACTIONS = defineRecordType<Transaction>("transactions", "txnId", Transaction);
export const DISPUTES = defineRecordType<Dispute>("disputes", "disputeId", Dispute);

/** Order fixes the leaf ordering of the dataset Merkle tree; changing it moves the root. */
export const WORLD_RECORD_TYPES: readonly ErasedRecordType[] = [
  CUSTOMERS,
  MERCHANTS,
  CARDS,
  DEVICES,
  IP_ADDRESSES,
  SESSIONS,
  AUTH_EVENTS,
  PROFILE_CHANGES,
  TRANSACTIONS,
  DISPUTES,
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
