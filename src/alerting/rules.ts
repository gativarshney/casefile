/**
 * The upstream rules engine — the system Casefile sits *after*, not part of it.
 *
 * These rules are deliberately coarse and tuned for recall, the way a production engine
 * is: they over-alert, and clearing the noise is the analyst's day. Casefile's job is to
 * triage that output, which also makes this the baseline every evaluation reports
 * against.
 *
 * Kept structurally separate from the probes: if the verifier reasoned over the same
 * signals that raised the alert, the evaluation would be circular. Rules here look at
 * single coarse thresholds; probes gather evidence and weigh it against exculpatory
 * history.
 */
import {
  CUSTOMERS,
  DEVICES,
  MERCHANTS,
  PROFILE_CHANGES,
  SESSIONS,
  TRANSACTIONS,
  type Transaction,
} from "../world/schema.js";
import type { WorldReader } from "../world/store.js";

export interface Alert {
  readonly alertId: string;
  readonly txnId: string;
  readonly ruleId: string;
  readonly raisedAtMs: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const RULES = {
  amountAboveTicket: "rule.amount_above_merchant_ticket",
  declineVelocity: "rule.decline_velocity",
  newDeviceHighValue: "rule.new_device_high_value",
  shippingMismatch: "rule.shipping_city_mismatch",
  profileChangeThenPurchase: "rule.profile_change_then_purchase",
  sharedDevice: "rule.device_shared_across_accounts",
  liquidMerchantVelocity: "rule.liquid_merchant_velocity",
} as const;

export const THRESHOLDS = {
  ticketMultiple: 5,
  declineCount: 3,
  declineWindowMs: 6 * HOUR_MS,
  newDeviceAgeMs: 7 * DAY_MS,
  newDeviceAmountMinor: 500_000,
  profileChangeWindowMs: 24 * HOUR_MS,
  sharedDeviceAccounts: 4,
  liquidCount: 5,
  liquidWindowMs: 24 * HOUR_MS,
} as const;

const LIQUID_CATEGORIES: ReadonlySet<string> = new Set(["gift_cards", "wallet_topup", "gaming"]);

export function raiseAlerts(reader: WorldReader): Alert[] {
  const transactions = reader.all(TRANSACTIONS);
  const merchants = new Map(reader.all(MERCHANTS).map((m) => [m.merchantId, m]));
  const customers = new Map(reader.all(CUSTOMERS).map((c) => [c.customerId, c]));
  const sessions = new Map(reader.all(SESSIONS).map((s) => [s.sessionId, s]));
  const devices = new Map(reader.all(DEVICES).map((d) => [d.deviceId, d]));

  const declineTimes = groupTimes(
    transactions.filter((t) => t.status === "declined"),
    (t) => t.customerId,
  );
  const liquidTimes = groupTimes(
    transactions.filter((t) => LIQUID_CATEGORIES.has(merchants.get(t.merchantId)?.category ?? "")),
    (t) => t.customerId,
  );

  const changeTimes = new Map<string, number[]>();
  for (const change of reader.all(PROFILE_CHANGES)) {
    changeTimes.set(change.customerId, [
      ...(changeTimes.get(change.customerId) ?? []),
      change.atMs,
    ]);
  }

  const accountsPerDevice = new Map<string, Set<string>>();
  for (const session of sessions.values()) {
    if (!session.customerId) continue;
    const set = accountsPerDevice.get(session.deviceId) ?? new Set<string>();
    set.add(session.customerId);
    accountsPerDevice.set(session.deviceId, set);
  }

  const alerts: Alert[] = [];
  for (const txn of transactions) {
    const session = sessions.get(txn.sessionId);
    const device = session ? devices.get(session.deviceId) : undefined;
    const ruleId = firstMatchingRule(txn, {
      merchantTicket: merchants.get(txn.merchantId)?.avgTicketMinor,
      homeCity: txn.customerId ? customers.get(txn.customerId)?.homeCity : undefined,
      deviceFirstSeenAtMs: device?.firstSeenAtMs,
      accountsOnDevice: session ? (accountsPerDevice.get(session.deviceId)?.size ?? 0) : 0,
      recentDeclines: countWithin(
        declineTimes,
        txn.customerId,
        txn.atMs,
        THRESHOLDS.declineWindowMs,
      ),
      recentLiquid: countWithin(liquidTimes, txn.customerId, txn.atMs, THRESHOLDS.liquidWindowMs),
      recentProfileChanges: countWithin(
        changeTimes,
        txn.customerId,
        txn.atMs,
        THRESHOLDS.profileChangeWindowMs,
      ),
    });
    if (ruleId === null) continue;
    alerts.push({
      alertId: `alert_${txn.txnId}`,
      txnId: txn.txnId,
      ruleId,
      raisedAtMs: txn.atMs,
    });
  }
  return alerts;
}

interface RuleInputs {
  readonly merchantTicket: number | undefined;
  readonly homeCity: string | undefined;
  readonly deviceFirstSeenAtMs: number | undefined;
  readonly accountsOnDevice: number;
  readonly recentDeclines: number;
  readonly recentLiquid: number;
  readonly recentProfileChanges: number;
}

function firstMatchingRule(txn: Transaction, inputs: RuleInputs): string | null {
  if (inputs.recentDeclines >= THRESHOLDS.declineCount) return RULES.declineVelocity;

  if (inputs.recentProfileChanges > 0) return RULES.profileChangeThenPurchase;

  if (
    inputs.deviceFirstSeenAtMs !== undefined &&
    txn.atMs - inputs.deviceFirstSeenAtMs <= THRESHOLDS.newDeviceAgeMs &&
    txn.amountMinor >= THRESHOLDS.newDeviceAmountMinor
  ) {
    return RULES.newDeviceHighValue;
  }

  if (
    txn.shippingCity !== null &&
    inputs.homeCity !== undefined &&
    txn.shippingCity !== inputs.homeCity
  ) {
    return RULES.shippingMismatch;
  }

  if (inputs.accountsOnDevice >= THRESHOLDS.sharedDeviceAccounts) return RULES.sharedDevice;

  if (inputs.recentLiquid >= THRESHOLDS.liquidCount) return RULES.liquidMerchantVelocity;

  if (
    inputs.merchantTicket !== undefined &&
    txn.amountMinor >= inputs.merchantTicket * THRESHOLDS.ticketMultiple
  ) {
    return RULES.amountAboveTicket;
  }

  return null;
}

function groupTimes(
  transactions: readonly Transaction[],
  key: (txn: Transaction) => string | null,
): Map<string, number[]> {
  const grouped = new Map<string, number[]>();
  for (const txn of transactions) {
    const id = key(txn);
    if (id === null) continue;
    grouped.set(id, [...(grouped.get(id) ?? []), txn.atMs]);
  }
  return grouped;
}

function countWithin(
  times: ReadonlyMap<string, number[]>,
  customerId: string | null,
  atMs: number,
  windowMs: number,
): number {
  if (customerId === null) return 0;
  return (times.get(customerId) ?? []).filter((time) => time <= atMs && atMs - time <= windowMs)
    .length;
}
