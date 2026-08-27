import { quantise } from "../canon/canonical.js";
import type { Evidence, Finding } from "../evidence/types.js";

/**
 * Findings are the vocabulary the scorer works in. Each is a named, bounded observation
 * derived from one piece of evidence, carrying a direction and an intensity in [0, 1].
 *
 * Intensity is separated from weight deliberately: a finding says *how strongly the
 * evidence presents*, while the fitted coefficient says *how much that matters*. Only
 * the second is learned, which keeps the explanation readable — a reviewer sees the
 * observation and its contribution as two separate, checkable numbers.
 */
export const FINDING_CODES = [
  "card.bin_spread",
  "card.hard_decline_mix",
  "velocity.above_baseline",
  "amount.above_merchant_ticket",
  "amount.above_customer_norm",
  "device.new_to_account",
  "device.automation_signals",
  "device.shared_recently",
  "device.shared_across_cities",
  "network.datacenter_or_vpn",
  "network.crowded_address",
  "geo.implausible_travel",
  "auth.failed_logins",
  "auth.step_up_failed",
  "auth.checks_unavailable",
  "profile.recent_contact_change",
  "merchant.high_liquidity",
  "shipping.unrecognised_destination",
  "history.prior_disputes",
  "content.injection_attempt",
  "history.established_account",
  "history.settled_volume",
  "history.known_device",
  "history.merchant_relationship",
  "history.institutional_network",
] as const;

export type FindingCode = (typeof FINDING_CODES)[number];

/**
 * Which way each finding argues. The fitted model is constrained to agree, so evidence
 * against a customer can never end up lowering their risk score.
 */
export const FINDING_DIRECTION: Readonly<Record<FindingCode, 1 | -1>> = {
  "card.bin_spread": 1,
  "card.hard_decline_mix": 1,
  "velocity.above_baseline": 1,
  "amount.above_merchant_ticket": 1,
  "amount.above_customer_norm": 1,
  "device.new_to_account": 1,
  "device.automation_signals": 1,
  "device.shared_recently": 1,
  "device.shared_across_cities": 1,
  "network.datacenter_or_vpn": 1,
  "network.crowded_address": 1,
  "geo.implausible_travel": 1,
  "auth.failed_logins": 1,
  "auth.step_up_failed": 1,
  "auth.checks_unavailable": 1,
  "profile.recent_contact_change": 1,
  "merchant.high_liquidity": 1,
  "shipping.unrecognised_destination": 1,
  "history.prior_disputes": 1,
  "content.injection_attempt": 1,
  "history.established_account": -1,
  "history.settled_volume": -1,
  "history.known_device": -1,
  "history.merchant_relationship": -1,
  "history.institutional_network": -1,
};

const clamp = (value: number): number => Math.max(0, Math.min(1, value));

type Emitter = (
  code: FindingCode,
  direction: Finding["direction"],
  intensity: number,
  summary: string,
  evidenceId: string,
) => void;

export function deriveFindings(evidence: readonly Evidence[]): Finding[] {
  const findings: Finding[] = [];
  const emit: Emitter = (code, direction, intensity, summary, evidenceId) => {
    const bounded = clamp(intensity);
    if (bounded <= 0) return;
    findings.push({
      code,
      direction,
      intensity: quantise(bounded, 6),
      evidenceIds: [evidenceId],
      summary,
    });
  };

  for (const item of evidence) {
    const payload = item.payload as Record<string, never>;
    const id = item.evidenceId;
    switch (item.probe) {
      case "probe.card_enumeration":
        enumerationFindings(payload, id, emit);
        break;
      case "probe.velocity_baseline":
        velocityFindings(payload, id, emit);
        break;
      case "probe.amount_context":
        amountFindings(payload, id, emit);
        break;
      case "probe.device_history":
        deviceFindings(payload, id, emit);
        break;
      case "probe.device_sharing":
        sharingFindings(payload, id, emit);
        break;
      case "probe.ip_reputation":
        ipFindings(payload, id, emit);
        break;
      case "probe.ip_sharing":
        ipSharingFindings(payload, id, emit);
        break;
      case "probe.geo_velocity":
        geoFindings(payload, id, emit);
        break;
      case "probe.auth_outcomes":
        authFindings(payload, id, emit);
        break;
      case "probe.profile_churn":
        profileFindings(payload, id, emit);
        break;
      case "probe.customer_tenure":
        tenureFindings(payload, id, emit);
        break;
      case "probe.merchant_relationship":
        relationshipFindings(payload, id, emit);
        break;
      case "probe.merchant_context":
        merchantFindings(payload, id, emit);
        break;
      case "probe.shipping_consistency":
        shippingFindings(payload, id, emit);
        break;
      case "probe.dispute_history":
        disputeFindings(payload, id, emit);
        break;
      case "probe.content_safety":
        emit(
          "content.injection_attempt",
          "inculpatory",
          1,
          `checkout text contains an instruction-shaped payload (${(payload.patterns as unknown as string[]).join(", ")})`,
          id,
        );
        break;
      default:
        break;
    }
  }

  findings.sort((a, b) => a.code.localeCompare(b.code));
  return findings;
}

function enumerationFindings(p: Record<string, never>, id: string, emit: Emitter): void {
  const bins = p.distinctBins as unknown as number;
  const attempts = p.attempts as unknown as number;
  const hard = p.hardDeclines as unknown as number;
  if (bins >= 3) {
    emit(
      "card.bin_spread",
      "inculpatory",
      (bins - 2) / 6,
      `${bins} distinct card issuers attempted within ${p.windowHours as unknown as number} hours`,
      id,
    );
  }
  if (attempts >= 3 && hard >= 2) {
    emit(
      "card.hard_decline_mix",
      "inculpatory",
      hard / Math.max(3, attempts),
      `${hard} of ${attempts} attempts hard-declined by the issuer`,
      id,
    );
  }
}

function velocityFindings(p: Record<string, never>, id: string, emit: Emitter): void {
  const ratio = (p.ratioToBaselineBps as unknown as number) / 10_000;
  const count = p.transactionsLast24h as unknown as number;
  if (ratio > 3 && count >= 3) {
    emit(
      "velocity.above_baseline",
      "inculpatory",
      (ratio - 3) / 12,
      `${count} transactions in 24h against a baseline of ${((p.historicalDailyRateBps as unknown as number) / 10_000).toFixed(1)}/day`,
      id,
    );
  }
}

function amountFindings(p: Record<string, never>, id: string, emit: Emitter): void {
  const ticketRatio = (p.ticketRatioBps as unknown as number) / 10_000;
  const customerRatio = (p.customerRatioBps as unknown as number) / 10_000;
  if (ticketRatio > 3) {
    emit(
      "amount.above_merchant_ticket",
      "inculpatory",
      (ticketRatio - 3) / 8,
      `amount is ${ticketRatio.toFixed(1)}x this merchant's typical ticket`,
      id,
    );
  }
  if (customerRatio > 4 && (p.priorCaptures as unknown as number) >= 5) {
    emit(
      "amount.above_customer_norm",
      "inculpatory",
      (customerRatio - 4) / 10,
      `amount is ${customerRatio.toFixed(1)}x this customer's median purchase`,
      id,
    );
  }
}

function deviceFindings(p: Record<string, never>, id: string, emit: Emitter): void {
  const known = p.knownToAccountDays as unknown as number;
  const priorSessions = p.priorSessionsOnDevice as unknown as number;
  if (priorSessions === 0) {
    emit(
      "device.new_to_account",
      "inculpatory",
      0.8,
      "device has never been used by this account",
      id,
    );
  } else if (known >= 60) {
    emit(
      "history.known_device",
      "exculpatory",
      Math.min(1, known / 180),
      `device has been used by this account for ${known} days across ${priorSessions} sessions`,
      id,
    );
  }
  if (p.automationSignals as unknown as boolean) {
    emit("device.automation_signals", "inculpatory", 0.7, "device reports automation signals", id);
  }
}

function sharingFindings(p: Record<string, never>, id: string, emit: Emitter): void {
  const accounts = p.accountsOnDevice as unknown as number;
  const coOccurrence = p.coOccurrenceDays as unknown as number;
  const spread = p.accountArrivalSpreadDays as unknown as number;
  const cities = p.distinctHomeCities as unknown as number;
  if (accounts < 3) return;

  // A household shares a device for months; a mule cluster appears on one within days.
  // Sharing is only suspicious when it is recent and tightly grouped.
  if (coOccurrence < 45 || spread < 21) {
    emit(
      "device.shared_recently",
      "inculpatory",
      Math.min(1, accounts / 8) * (spread < 21 ? 1 : 0.6),
      `${accounts} accounts appeared on this device within ${spread} days`,
      id,
    );
  }
  if (cities >= 3) {
    emit(
      "device.shared_across_cities",
      "inculpatory",
      Math.min(1, cities / 5),
      `${accounts} accounts on this device claim ${cities} different home cities`,
      id,
    );
  }
}

function ipFindings(p: Record<string, never>, id: string, emit: Emitter): void {
  if ((p.isDatacenter as unknown as boolean) || (p.vpnSuspected as unknown as boolean)) {
    const priorUse = p.priorSessionsFromThisAddress as unknown as number;
    emit(
      "network.datacenter_or_vpn",
      "inculpatory",
      priorUse > 3 ? 0.25 : 0.7,
      `connection from ${p.asnOrg as unknown as string}${priorUse > 3 ? `, previously used ${priorUse} times by this account` : ""}`,
      id,
    );
  }
}

function ipSharingFindings(p: Record<string, never>, id: string, emit: Emitter): void {
  const accounts = p.accountsOnAddress as unknown as number;
  const org = (p.asnOrg as unknown as string).toLowerCase();
  const institutional = /nkn|ernet|university|college|campus/.test(org);
  if (institutional) {
    emit(
      "history.institutional_network",
      "exculpatory",
      0.6,
      `address belongs to ${p.asnOrg as unknown as string}, where many unrelated accounts are expected`,
      id,
    );
    return;
  }
  if (accounts >= 4) {
    emit(
      "network.crowded_address",
      "inculpatory",
      Math.min(1, (accounts - 3) / 8),
      `${accounts} accounts share this address on ${p.asnOrg as unknown as string}`,
      id,
    );
  }
}

function geoFindings(p: Record<string, never>, id: string, emit: Emitter): void {
  if ((p.implausible as unknown as string) !== "yes") return;
  emit(
    "geo.implausible_travel",
    "inculpatory",
    0.9,
    `${p.fromCity as unknown as string} to ${p.toCity as unknown as string} in ${p.elapsedMinutes as unknown as number} minutes`,
    id,
  );
}

function authFindings(p: Record<string, never>, id: string, emit: Emitter): void {
  const failed = p.failedLogins as unknown as number;
  const stepUp = p.stepUpFailures as unknown as number;
  if (failed >= 2) {
    emit(
      "auth.failed_logins",
      "inculpatory",
      Math.min(1, failed / 5),
      `${failed} failed sign-in attempts before this payment`,
      id,
    );
  }
  if (stepUp >= 1) {
    emit(
      "auth.step_up_failed",
      "inculpatory",
      Math.min(1, stepUp / 2),
      `${stepUp} step-up authentication challenge(s) not passed`,
      id,
    );
  }
  const unavailable = [p.threeDsResult, p.avsResult, p.cvvResult].filter(
    (result) => (result as unknown as string) === "unavailable",
  ).length;
  if (unavailable >= 2) {
    emit(
      "auth.checks_unavailable",
      "inculpatory",
      unavailable / 3,
      `${unavailable} verification checks could not be performed`,
      id,
    );
  }
}

function profileFindings(p: Record<string, never>, id: string, emit: Emitter): void {
  if (!(p.contactDetailChanged as unknown as boolean)) return;
  const hours = p.hoursSinceLatest as unknown as number;
  if (hours > 72) return;
  emit(
    "profile.recent_contact_change",
    "inculpatory",
    Math.max(0.2, 1 - hours / 72),
    `contact details changed ${hours}h before this payment (${(p.fieldsChanged as unknown as string[]).join(", ")})`,
    id,
  );
}

function tenureFindings(p: Record<string, never>, id: string, emit: Emitter): void {
  const age = p.accountAgeDays as unknown as number;
  const captures = p.priorCapturedCount as unknown as number;
  if (age >= 90 && (p.kycLevel as unknown as number) >= 1) {
    emit(
      "history.established_account",
      "exculpatory",
      Math.min(1, age / 365),
      `account is ${age} days old at verification level ${p.kycLevel as unknown as number}`,
      id,
    );
  }
  if (captures >= 5) {
    emit(
      "history.settled_volume",
      "exculpatory",
      Math.min(1, captures / 40),
      `${captures} settled payments across ${p.distinctMerchantsUsed as unknown as number} merchants`,
      id,
    );
  }
}

function relationshipFindings(p: Record<string, never>, id: string, emit: Emitter): void {
  const captures = p.priorCaptures as unknown as number;
  if (captures < 1) return;
  emit(
    "history.merchant_relationship",
    "exculpatory",
    Math.min(1, captures / 8),
    `${captures} previous settled payment(s) with this merchant over ${p.relationshipDays as unknown as number} days`,
    id,
  );
}

function merchantFindings(p: Record<string, never>, id: string, emit: Emitter): void {
  if (!(p.highLiquidity as unknown as boolean)) return;
  emit(
    "merchant.high_liquidity",
    "inculpatory",
    0.4,
    `${p.category as unknown as string} converts to value quickly and is disproportionately targeted`,
    id,
  );
}

function shippingFindings(p: Record<string, never>, id: string, emit: Emitter): void {
  if ((p.matchesHome as unknown as boolean) || (p.seenBefore as unknown as boolean)) return;
  emit(
    "shipping.unrecognised_destination",
    "inculpatory",
    0.6,
    `goods directed to ${p.shippingCity as unknown as string}, never used before by this account`,
    id,
  );
}

function disputeFindings(p: Record<string, never>, id: string, emit: Emitter): void {
  const disputes = p.priorDisputes as unknown as number;
  if (disputes === 0) return;
  emit(
    "history.prior_disputes",
    "inculpatory",
    Math.min(1, disputes / 3),
    `${disputes} earlier dispute(s) on this account, ${p.unauthorisedClaims as unknown as number} claiming unauthorised use`,
    id,
  );
}
