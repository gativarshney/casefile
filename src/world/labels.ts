/**
 * Ground truth about the simulated world — the answer key.
 *
 * It lives in a physically separate database file from the world itself, and nothing on
 * the investigation path may import this module; the import-boundary test enforces that
 * mechanically. Only the generator writes it and only the evaluation harness reads it.
 */
import { z } from "zod";
import { defineRecordType, EpochMs, type ErasedRecordType } from "./schema.js";
import { WorldReader } from "./store.js";

export const FraudFamily = z.enum([
  "card_testing",
  "account_takeover",
  "abuse_ring",
  "friendly_fraud",
]);
export type FraudFamily = z.infer<typeof FraudFamily>;

/**
 * Variants describe method where families describe motive — and method is what a
 * detector can overfit to. Two variants exist only in the held-out world, chosen to
 * attack the two most likely shortcuts: velocity thresholds and graph reliance.
 */
export const FraudVariant = z.enum([
  "burst",
  "slow_low",
  "credential_stuffing",
  "session_hijack",
  "shared_infrastructure",
  "timing_only",
  "buyers_remorse",
  "family_member",
]);
export type FraudVariant = z.infer<typeof FraudVariant>;

export const NOVEL_VARIANTS: readonly FraudVariant[] = ["slow_low", "timing_only"];

/** Legitimate behaviour deliberately built to resemble fraud. */
export const DecoyKind = z.enum([
  "high_velocity_reseller",
  "shared_household_device",
  "shared_campus_network",
  "travelling_customer",
  "vpn_user",
  "card_reissue",
  "card_retry_after_declines",
  "gift_to_new_address",
  "first_purchase_high_value",
  "new_device_on_holiday",
  "high_dispute_merchant",
]);
export type DecoyKind = z.infer<typeof DecoyKind>;

export const TransactionLabel = z.object({
  txnId: z.string().min(1),
  isFraud: z.boolean(),
  family: FraudFamily.nullable(),
  variant: FraudVariant.nullable(),
  scenarioId: z.string().min(1).nullable(),
  decoyKind: DecoyKind.nullable(),
  /** Archetype of the acting customer; used only for per-cohort reporting. */
  archetype: z.string().min(1).nullable(),
  atMs: EpochMs,
});
export type TransactionLabel = z.infer<typeof TransactionLabel>;

export const EntityLabel = z.object({
  labelId: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  role: z.enum(["legitimate", "victim", "mule", "fraudster"]),
  scenarioId: z.string().min(1).nullable(),
});
export type EntityLabel = z.infer<typeof EntityLabel>;

export const TRANSACTION_LABELS = defineRecordType<TransactionLabel>(
  "transaction_labels",
  "txnId",
  TransactionLabel,
);
export const ENTITY_LABELS = defineRecordType<EntityLabel>("entity_labels", "labelId", EntityLabel);

export const LABEL_RECORD_TYPES: readonly ErasedRecordType[] = [TRANSACTION_LABELS, ENTITY_LABELS];

/**
 * Defined here rather than in the store so the storage layer carries no dependency on
 * the answer key: the investigation path imports the store, and must not gain a route
 * to labels through it.
 */
export class LabelReader extends WorldReader {
  constructor(path: string) {
    super(path, LABEL_RECORD_TYPES);
  }
}
