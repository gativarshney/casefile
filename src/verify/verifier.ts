/**
 * Turns evidence into findings, findings into a score, and a score into an action.
 *
 * The weights here are declared constants, not fitted ones. Phase 5 replaces them with
 * coefficients from a calibrated logistic regression and a threshold derived from an
 * explicit cost matrix; the seam is deliberate, so nothing downstream changes when it
 * does. Until then no probability claim is made — `score` is a bounded index, and the
 * README says so.
 */
import { quantise } from "../canon/canonical.js";
import type { Claim, Evidence, Finding } from "../evidence/types.js";

export type Action = "confirm" | "escalate" | "clear";

export interface Assessment {
  readonly findings: readonly Finding[];
  readonly claims: readonly Claim[];
  readonly score: string;
  readonly action: Action;
}

const WEIGHTS = {
  binSpread: 34,
  declineRate: 26,
  liquidCapture: 12,
  establishedAccount: -28,
  settledHistory: -18,
} as const;

const THRESHOLDS = { confirm: 40, escalate: 15 } as const;

interface EnumerationPayload {
  attempts: number;
  distinctBins: number;
  distinctCards: number;
  declined: number;
  declineRateBps: number;
  windowHours: number;
}

interface TenurePayload {
  accountAgeDays: number;
  priorCapturedCount: number;
  priorCapturedValueMinor: number;
  kycLevel: number;
}

export function assess(evidence: readonly Evidence[]): Assessment {
  const findings: Finding[] = [];

  for (const item of evidence) {
    if (item.probe === "probe.card_enumeration") {
      findings.push(...enumerationFindings(item, item.payload as unknown as EnumerationPayload));
    }
    if (item.probe === "probe.customer_tenure") {
      findings.push(...tenureFindings(item, item.payload as unknown as TenurePayload));
    }
  }

  findings.sort((a, b) => a.code.localeCompare(b.code));
  const total = findings.reduce((sum, finding) => sum + finding.weight, 0);

  return {
    findings,
    claims: findings.map((finding) => ({
      statement: finding.summary,
      evidenceIds: finding.evidenceIds,
    })),
    // The bounded index keeps the slice honest: it is a sum of declared weights, not a
    // probability, and quantise() is what stops a float reaching the sealed artifact.
    score: quantise(Math.max(-100, Math.min(100, total)) / 100, 4),
    action:
      total >= THRESHOLDS.confirm ? "confirm" : total >= THRESHOLDS.escalate ? "escalate" : "clear",
  };
}

function enumerationFindings(evidence: Evidence, payload: EnumerationPayload): Finding[] {
  const findings: Finding[] = [];
  const ids = [evidence.evidenceId];

  if (payload.distinctBins >= 4) {
    findings.push({
      code: "card.bin_spread",
      direction: "inculpatory",
      weight: WEIGHTS.binSpread,
      evidenceIds: ids,
      summary: `${payload.distinctBins} distinct card BINs attempted by one account within ${payload.windowHours} hours`,
    });
  }
  if (payload.attempts >= 5 && payload.declineRateBps >= 6_000) {
    findings.push({
      code: "card.decline_rate",
      direction: "inculpatory",
      weight: WEIGHTS.declineRate,
      evidenceIds: ids,
      summary: `${payload.declined} of ${payload.attempts} attempts declined (${(payload.declineRateBps / 100).toFixed(0)}%)`,
    });
  }
  if (payload.declined >= 3 && payload.attempts > payload.declined) {
    findings.push({
      code: "card.success_after_failures",
      direction: "inculpatory",
      weight: WEIGHTS.liquidCapture,
      evidenceIds: ids,
      summary: `a capture followed ${payload.declined} declined attempts in the same window`,
    });
  }
  return findings;
}

function tenureFindings(evidence: Evidence, payload: TenurePayload): Finding[] {
  const findings: Finding[] = [];
  const ids = [evidence.evidenceId];

  if (payload.accountAgeDays >= 90 && payload.kycLevel >= 1) {
    findings.push({
      code: "history.established_account",
      direction: "exculpatory",
      weight: WEIGHTS.establishedAccount,
      evidenceIds: ids,
      summary: `account is ${payload.accountAgeDays} days old at KYC level ${payload.kycLevel}`,
    });
  }
  if (payload.priorCapturedCount >= 3) {
    findings.push({
      code: "history.settled_payments",
      direction: "exculpatory",
      weight: WEIGHTS.settledHistory,
      evidenceIds: ids,
      summary: `${payload.priorCapturedCount} previously settled payments on this account`,
    });
  }
  return findings;
}

export { THRESHOLDS, WEIGHTS };
