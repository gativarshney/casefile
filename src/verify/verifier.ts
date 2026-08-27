import { quantise } from "../canon/canonical.js";
import type { Claim, Evidence, Finding } from "../evidence/types.js";
import {
  type Contribution,
  type FrozenModel,
  modelHash,
  scoreWithContributions,
} from "../scoring/model.js";
import { deriveFindings, FINDING_CODES, FINDING_DIRECTION } from "./findings.js";
import { type Action, type CostModel, DEFAULT_COSTS, decide } from "./policy.js";

export interface Assessment {
  readonly findings: readonly Finding[];
  readonly claims: readonly Claim[];
  readonly features: readonly string[];
  readonly contributions: readonly Contribution[];
  readonly logOdds: string;
  readonly fraudProbability: string;
  readonly action: Action;
  readonly expectedCostMinor: number;
  readonly modelHash: string;
}

/**
 * Findings become a fixed-width feature vector by code.
 *
 * The order is `FINDING_CODES`, so a coefficient always refers to the same observation
 * and a frozen model stays meaningful across runs. A code that fires more than once
 * contributes its strongest instance rather than accumulating, which keeps every
 * feature bounded in [0, 1] and stops a single noisy probe dominating the score.
 */
export function toFeatureVector(findings: readonly Finding[]): number[] {
  const byCode = new Map<string, number>();
  for (const finding of findings) {
    byCode.set(finding.code, Math.max(byCode.get(finding.code) ?? 0, Number(finding.intensity)));
  }
  return FINDING_CODES.map((code) => byCode.get(code) ?? 0);
}

export const FEATURE_NAMES: readonly string[] = FINDING_CODES;

/** Sign constraint per feature, in the same order as {@link FEATURE_NAMES}. */
export const FEATURE_SIGNS: readonly (1 | -1)[] = FINDING_CODES.map(
  (code) => FINDING_DIRECTION[code],
);

export function assess(
  evidence: readonly Evidence[],
  model: FrozenModel,
  amountMinor: number,
  costs: CostModel = DEFAULT_COSTS,
): Assessment {
  const findings = deriveFindings(evidence);
  const features = toFeatureVector(findings);
  const scored = scoreWithContributions(model, features);
  const decision = decide(scored.calibratedProbability, amountMinor, costs);

  return {
    findings,
    claims: findings.map((finding) => ({
      statement: finding.summary,
      evidenceIds: finding.evidenceIds,
    })),
    features: features.map((value) => quantise(value, 6)),
    contributions: scored.contributions,
    logOdds: quantise(scored.logOdds, 6),
    fraudProbability: quantise(scored.calibratedProbability, 6),
    action: decision.action,
    expectedCostMinor: decision.expectedCostMinor,
    modelHash: modelHash(model),
  };
}

export { deriveFindings, FINDING_CODES, FINDING_DIRECTION } from "./findings.js";
export type { Action, CostModel } from "./policy.js";
export { DEFAULT_COSTS, decide, decisionBoundaries, realisedCostMinor } from "./policy.js";
