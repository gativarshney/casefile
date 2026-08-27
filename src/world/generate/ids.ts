import { createHash } from "node:crypto";

export type EntityKind =
  | "customer"
  | "merchant"
  | "card"
  | "device"
  | "ip"
  | "session"
  | "auth"
  | "change"
  | "txn"
  | "dispute"
  | "scenario";

const PREFIX: Record<EntityKind, string> = {
  customer: "cust",
  merchant: "mer",
  card: "card",
  device: "dev",
  ip: "ip",
  session: "ses",
  auth: "auth",
  change: "chg",
  txn: "txn",
  dispute: "dsp",
  scenario: "sc",
};

/**
 * Identifiers are one-way hashes of (namespace, seed, kind, parts). Fraud and
 * legitimate actors draw from one indistinguishable namespace: nothing about an id
 * reveals what produced it, in which order, or with which role — an id pattern must
 * never be a feature.
 */
export function entityId(
  namespace: string,
  seed: number,
  kind: EntityKind,
  ...parts: readonly (string | number)[]
): string {
  const material = [namespace, String(seed), kind, ...parts.map(String)].join("");
  const body = createHash("sha256").update(material).digest("hex").slice(0, 16);
  return `${PREFIX[kind]}_${body}`;
}
