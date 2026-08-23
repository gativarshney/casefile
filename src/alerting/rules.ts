/**
 * The upstream rules engine — the system Casefile sits *after*, not part of it.
 *
 * These rules are deliberately coarse and tuned for recall, the way a production engine
 * is: they over-alert, and clearing the noise is the analyst's day. Casefile's job is to
 * triage that output, which also makes the rules engine the baseline every evaluation
 * reports against.
 *
 * Kept structurally separate from the probes: if the verifier reasoned over the same
 * signals that raised the alert, the evaluation would be circular.
 */
import { MERCHANTS, TRANSACTIONS, type Transaction } from "../world/schema.js";
import type { WorldReader } from "../world/store.js";

export interface Alert {
  readonly alertId: string;
  readonly txnId: string;
  readonly ruleId: string;
  readonly raisedAtMs: number;
}

const HOUR_MS = 3_600_000;

export const RULES = {
  amountAboveTicket: "rule.amount_above_merchant_ticket",
  declineVelocity: "rule.decline_velocity",
} as const;

export const THRESHOLDS = {
  ticketMultiple: 3,
  declineCount: 3,
  declineWindowMs: 6 * HOUR_MS,
} as const;

export function raiseAlerts(reader: WorldReader): Alert[] {
  const transactions = reader.all(TRANSACTIONS);
  const ticketByMerchant = new Map(
    reader.all(MERCHANTS).map((merchant) => [merchant.merchantId, merchant.avgTicketMinor]),
  );

  const declineTimes = new Map<string, number[]>();
  for (const txn of transactions) {
    if (txn.status !== "declined" || txn.customerId === null) continue;
    declineTimes.set(txn.customerId, [...(declineTimes.get(txn.customerId) ?? []), txn.atMs]);
  }

  const alerts: Alert[] = [];
  for (const txn of transactions) {
    const ruleId = matchRule(txn, ticketByMerchant, declineTimes);
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

function matchRule(
  txn: Transaction,
  ticketByMerchant: ReadonlyMap<string, number>,
  declineTimes: ReadonlyMap<string, number[]>,
): string | null {
  if (txn.customerId !== null) {
    const recent = (declineTimes.get(txn.customerId) ?? []).filter(
      (at) => at <= txn.atMs && txn.atMs - at <= THRESHOLDS.declineWindowMs,
    );
    if (recent.length >= THRESHOLDS.declineCount) return RULES.declineVelocity;
  }

  const ticket = ticketByMerchant.get(txn.merchantId);
  if (ticket !== undefined && txn.amountMinor >= ticket * THRESHOLDS.ticketMultiple) {
    return RULES.amountAboveTicket;
  }
  return null;
}
