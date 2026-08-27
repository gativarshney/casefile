import type { Canonical } from "../canon/canonical.js";
import type { Digest } from "../canon/hash.js";
import { digest } from "../canon/hash.js";

/**
 * A pointer from evidence back to the row it was derived from, carrying that row's hash
 * at collection time. This is what makes a verdict falsifiable: replay recomputes the
 * hash from the live row and stops if it moved.
 */
export interface SourceRef {
  readonly table: string;
  readonly id: string;
  readonly hash: Digest;
}

export interface Evidence {
  readonly evidenceId: string;
  readonly probe: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly fromMs: number | null;
  readonly toMs: number | null;
  readonly sources: readonly SourceRef[];
  readonly payload: Canonical;
  readonly payloadHash: Digest;
}

/** Findings carry a sign: evidence that exonerates counts as much as evidence that accuses. */
export type FindingDirection = "inculpatory" | "exculpatory";

export interface Finding {
  readonly code: string;
  readonly direction: FindingDirection;
  /**
   * How strongly the evidence presents, in [0, 1], as a fixed-precision decimal string.
   * Deliberately separate from the fitted coefficient that decides how much it matters,
   * so a reviewer can check the observation and its contribution independently.
   */
  readonly intensity: string;
  readonly evidenceIds: readonly string[];
  readonly summary: string;
}

export interface Claim {
  readonly statement: string;
  readonly evidenceIds: readonly string[];
}

export function evidenceId(probe: string, subjectId: string, payloadHash: Digest): string {
  return `ev_${digest([probe, subjectId, payloadHash]).slice(7, 23)}`;
}

export function makeEvidence(input: {
  probe: string;
  subjectType: string;
  subjectId: string;
  fromMs: number | null;
  toMs: number | null;
  sources: readonly SourceRef[];
  payload: Canonical;
}): Evidence {
  const payloadHash = digest(input.payload);
  return {
    ...input,
    payloadHash,
    evidenceId: evidenceId(input.probe, input.subjectId, payloadHash),
  };
}
