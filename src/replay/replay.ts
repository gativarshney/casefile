/**
 * Replay re-executes a sealed case against the live world and requires bit-for-bit
 * agreement.
 *
 * Two failure modes are distinguished, because they mean opposite things:
 *
 * `IntegrityError` — a source record moved underneath the case. The evidence is no
 * longer what was reasoned over, so the verdict is void. This is what a tampered row
 * produces.
 *
 * `ReplayMismatchError` — every record is intact but Casefile produced a different
 * answer. The data is fine; the *system* changed. A non-deterministic probe or an
 * unversioned scoring change looks like this.
 */

import { type CaseArtifact, caseHashOf, investigate } from "../case/artifact.js";
import { type FrozenModel, modelHash } from "../scoring/model.js";
import { recordHash, TRANSACTIONS } from "../world/schema.js";
import type { DatasetManifest } from "../world/store.js";
import { IntegrityError, type WorldReader } from "../world/store.js";

export class ReplayMismatchError extends Error {
  readonly field: string;

  constructor(field: string, expected: unknown, actual: unknown) {
    super(`replay diverged on ${field}\n  sealed:   ${expected}\n  replayed: ${actual}`);
    this.name = "ReplayMismatchError";
    this.field = field;
  }
}

export interface ReplayResult {
  readonly caseId: string;
  readonly caseHash: string;
  readonly evidenceCount: number;
  readonly recordsVerified: number;
}

export function replayCase(
  reader: WorldReader,
  manifest: DatasetManifest,
  artifact: CaseArtifact,
  model: FrozenModel,
): ReplayResult {
  if (artifact.worldRoot !== manifest.worldRoot) {
    throw new IntegrityError(
      "case was built against a different world",
      "dataset",
      artifact.worldRoot,
      manifest.worldRoot,
    );
  }

  if (caseHashOf(artifact) !== artifact.caseHash) {
    throw new IntegrityError(
      "case artifact does not hash to its own sealed value",
      artifact.caseId,
      artifact.caseHash,
      caseHashOf(artifact),
    );
  }

  const recordsVerified = verifySources(reader, artifact);

  if (modelHash(model) !== artifact.modelHash) {
    throw new ReplayMismatchError("modelHash", artifact.modelHash, modelHash(model));
  }

  const replayed = investigate(reader, manifest, artifact.alert, model, artifact.plan);
  assertSame("evidence ids", ids(artifact), ids(replayed));
  assertSame("findings", fingerprintFindings(artifact), fingerprintFindings(replayed));
  assertSame("logOdds", artifact.logOdds, replayed.logOdds);
  assertSame("fraudProbability", artifact.fraudProbability, replayed.fraudProbability);
  assertSame("action", artifact.action, replayed.action);
  assertSame("caseHash", artifact.caseHash, replayed.caseHash);

  return {
    caseId: artifact.caseId,
    caseHash: artifact.caseHash,
    evidenceCount: artifact.evidence.length,
    recordsVerified,
  };
}

/**
 * Recomputes each cited record's hash from its live fields. The stored `record_hash`
 * column is never consulted: whoever can edit a row can edit that column too.
 */
function verifySources(reader: WorldReader, artifact: CaseArtifact): number {
  const subject = reader.get(TRANSACTIONS, artifact.subject.txnId);
  if (!subject) {
    throw new IntegrityError("subject transaction no longer exists", artifact.subject.txnId);
  }
  const subjectHash = recordHash(TRANSACTIONS, subject as unknown as Record<string, unknown>);
  if (subjectHash !== artifact.subject.hash) {
    throw new IntegrityError(
      "subject transaction has been modified since the case was sealed",
      `${TRANSACTIONS.table}:${artifact.subject.txnId}`,
      artifact.subject.hash,
      subjectHash,
    );
  }

  let verified = 1;
  for (const evidence of artifact.evidence) {
    for (const source of evidence.sources) {
      const type = reader.recordTypeFor(source.table);
      const record = reader.rawRecord(type, source.id);
      if (!record) {
        throw new IntegrityError(
          "a cited source record no longer exists",
          `${source.table}:${source.id}`,
          source.hash,
          "<deleted>",
        );
      }
      const actual = recordHash(type, record);
      if (actual !== source.hash) {
        throw new IntegrityError(
          "a cited source record has been modified since the case was sealed",
          `${source.table}:${source.id}`,
          source.hash,
          actual,
        );
      }
      verified += 1;
    }
  }
  return verified;
}

function ids(artifact: CaseArtifact): string {
  return artifact.evidence.map((item) => item.evidenceId).join(",");
}

function fingerprintFindings(artifact: CaseArtifact): string {
  return artifact.findings.map((f) => `${f.code}:${f.intensity}`).join(",");
}

function assertSame(field: string, expected: unknown, actual: unknown): void {
  if (expected !== actual) throw new ReplayMismatchError(field, expected, actual);
}
