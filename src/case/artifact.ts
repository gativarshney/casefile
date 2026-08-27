import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Alert } from "../alerting/rules.js";
import { chainAll, type Digest, digest } from "../canon/hash.js";
import type { Claim, Evidence, Finding } from "../evidence/types.js";
import { CaseContext, FULL_SWEEP, probeById } from "../probes/index.js";
import type { Contribution, FrozenModel } from "../scoring/model.js";
import { type Action, assess, type CostModel, DEFAULT_COSTS } from "../verify/verifier.js";
import { recordHash, TRANSACTIONS } from "../world/schema.js";
import type { DatasetManifest, WorldReader } from "../world/store.js";

export interface CaseArtifact {
  readonly caseId: string;
  readonly alert: Alert;
  /** Pins the case to the exact world it was built on. */
  readonly worldRoot: Digest;
  /**
   * The probes that ran, in order. Sealed so replay re-executes *this* investigation
   * rather than whatever the current probe registry happens to contain — which is also
   * what keeps replay deterministic when a model chooses the plan.
   */
  readonly plan: readonly string[];
  readonly subject: { readonly txnId: string; readonly hash: Digest };
  readonly evidence: readonly Evidence[];
  readonly findings: readonly Finding[];
  readonly claims: readonly Claim[];
  readonly features: readonly string[];
  readonly contributions: readonly Contribution[];
  readonly logOdds: string;
  readonly fraudProbability: string;
  readonly action: Action;
  readonly expectedCostMinor: number;
  readonly modelHash: string;
  readonly caseHash: Digest;
}

type SealedFields = Omit<CaseArtifact, "caseId" | "caseHash">;

/** The fields the chain commits to, in a fixed order. */
function chainSteps(fields: SealedFields): unknown[] {
  return [
    { step: "alert", value: fields.alert },
    { step: "world", value: fields.worldRoot },
    { step: "plan", value: fields.plan },
    { step: "subject", value: fields.subject },
    { step: "evidence", value: fields.evidence },
    { step: "findings", value: fields.findings },
    { step: "model", value: fields.modelHash },
    {
      step: "verdict",
      value: {
        logOdds: fields.logOdds,
        fraudProbability: fields.fraudProbability,
        action: fields.action,
        expectedCostMinor: fields.expectedCostMinor,
        claims: fields.claims,
      },
    },
  ];
}

export function investigate(
  reader: WorldReader,
  manifest: DatasetManifest,
  alert: Alert,
  model: FrozenModel,
  plan: readonly string[] = FULL_SWEEP,
  costs: CostModel = DEFAULT_COSTS,
): CaseArtifact {
  const subject = reader.get(TRANSACTIONS, alert.txnId);
  if (!subject) throw new Error(`alert ${alert.alertId} names an unknown transaction`);

  const context = new CaseContext(reader, subject);
  const evidence: Evidence[] = [];
  for (const probeId of plan) {
    const collected = probeById(probeId).run(context);
    if (collected) evidence.push(collected);
  }

  const assessment = assess(evidence, model, subject.amountMinor, costs);
  const fields: SealedFields = {
    alert,
    worldRoot: manifest.worldRoot,
    plan,
    subject: {
      txnId: subject.txnId,
      hash: recordHash(TRANSACTIONS, subject as unknown as Record<string, unknown>),
    },
    evidence,
    findings: assessment.findings,
    claims: assessment.claims,
    features: assessment.features,
    contributions: assessment.contributions,
    logOdds: assessment.logOdds,
    fraudProbability: assessment.fraudProbability,
    action: assessment.action,
    expectedCostMinor: assessment.expectedCostMinor,
    modelHash: assessment.modelHash,
  };

  return {
    caseId: `case_${digest([alert.alertId, manifest.worldRoot]).slice(7, 23)}`,
    ...fields,
    caseHash: chainAll(chainSteps(fields)).head as Digest,
  };
}

export function caseHashOf(artifact: CaseArtifact): Digest {
  const { caseId: _id, caseHash: _hash, ...fields } = artifact;
  return chainAll(chainSteps(fields)).head as Digest;
}

export function writeCase(path: string, artifact: CaseArtifact): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export function readCase(path: string): CaseArtifact {
  return JSON.parse(readFileSync(path, "utf8")) as CaseArtifact;
}
