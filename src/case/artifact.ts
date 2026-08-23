import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Alert } from "../alerting/rules.js";
import { chainAll, type Digest, digest } from "../canon/hash.js";
import type { Claim, Evidence, Finding } from "../evidence/types.js";
import { PROBES, probeById } from "../probes/index.js";
import { type Action, assess } from "../verify/verifier.js";
import { recordHash, TRANSACTIONS, type Transaction } from "../world/schema.js";
import type { DatasetManifest, WorldReader } from "../world/store.js";

export interface CaseArtifact {
  readonly caseId: string;
  readonly alert: Alert;
  /** Pins the case to the exact world it was built on. */
  readonly worldRoot: Digest;
  /**
   * The probes that ran, in order. Sealed so replay re-executes *this* investigation
   * rather than whatever the current probe registry happens to contain — which is also
   * what will keep replay deterministic once an LLM chooses the plan.
   */
  readonly plan: readonly string[];
  readonly subject: { readonly txnId: string; readonly hash: Digest };
  readonly evidence: readonly Evidence[];
  readonly findings: readonly Finding[];
  readonly claims: readonly Claim[];
  readonly score: string;
  readonly action: Action;
  readonly caseHash: Digest;
}

/** The fields the chain commits to, in a fixed order. */
function chainSteps(fields: Omit<CaseArtifact, "caseId" | "caseHash">): unknown[] {
  return [
    { step: "alert", value: fields.alert },
    { step: "world", value: fields.worldRoot },
    { step: "plan", value: fields.plan },
    { step: "subject", value: fields.subject },
    { step: "evidence", value: fields.evidence },
    { step: "findings", value: fields.findings },
    {
      step: "verdict",
      value: { score: fields.score, action: fields.action, claims: fields.claims },
    },
  ];
}

export function investigate(
  reader: WorldReader,
  manifest: DatasetManifest,
  alert: Alert,
  plan: readonly string[] = PROBES.map((probe) => probe.id),
): CaseArtifact {
  const subject = reader.get(TRANSACTIONS, alert.txnId);
  if (!subject) throw new Error(`alert ${alert.alertId} names an unknown transaction`);

  const evidence: Evidence[] = [];
  for (const probeId of plan) {
    const collected = probeById(probeId).run({ reader, subject });
    if (collected) evidence.push(collected);
  }

  const assessment = assess(evidence);
  const fields = {
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
    score: assessment.score,
    action: assessment.action,
  } satisfies Omit<CaseArtifact, "caseId" | "caseHash">;

  const { head } = chainAll(chainSteps(fields));
  return {
    caseId: `case_${digest([alert.alertId, manifest.worldRoot]).slice(7, 23)}`,
    ...fields,
    caseHash: head as Digest,
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

export type { Transaction };
