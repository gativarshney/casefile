/**
 * Probes gather evidence. Each is a pure function of the world and the subject, so the
 * same inputs always produce the same evidence — which is what makes a sealed case
 * replayable.
 *
 * A probe may never reach ground truth or the generator; see the boundary test.
 */
import { type Evidence, makeEvidence, type SourceRef } from "../evidence/types.js";
import { CARDS, CUSTOMERS, recordHash, TRANSACTIONS, type Transaction } from "../world/schema.js";
import type { WorldReader } from "../world/store.js";

export interface ProbeContext {
  readonly reader: WorldReader;
  readonly subject: Transaction;
}

export interface Probe {
  readonly id: string;
  run(context: ProbeContext): Evidence | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ENUMERATION_WINDOW_MS = 6 * HOUR_MS;

function txnSource(txn: Transaction): SourceRef {
  return {
    table: TRANSACTIONS.table,
    id: txn.txnId,
    hash: recordHash(TRANSACTIONS, txn as unknown as Record<string, unknown>),
  };
}

/**
 * Distinct BINs attempted and the decline ratio over a short window.
 *
 * One card failing is noise. Many *different* BINs failing from one account inside a few
 * hours is enumeration, because a genuine cardholder does not hold a dozen issuers.
 */
export const cardEnumeration: Probe = {
  id: "probe.card_enumeration",
  run({ reader, subject }) {
    if (subject.customerId === null) return null;

    const window = reader
      .query(TRANSACTIONS, "customerId = ? AND atMs <= ? AND atMs >= ?", [
        subject.customerId,
        subject.atMs,
        subject.atMs - ENUMERATION_WINDOW_MS,
      ])
      .sort((a, b) => a.atMs - b.atMs);
    if (window.length === 0) return null;

    const cards = reader.query(CARDS, "customerId = ?", [subject.customerId]);
    const binByCard = new Map(cards.map((card) => [card.cardId, card.bin]));
    const bins = new Set(
      window.map((txn) => binByCard.get(txn.cardId)).filter((bin): bin is string => Boolean(bin)),
    );
    const declined = window.filter((txn) => txn.status === "declined").length;

    return makeEvidence({
      probe: cardEnumeration.id,
      subjectType: "customer",
      subjectId: subject.customerId,
      fromMs: subject.atMs - ENUMERATION_WINDOW_MS,
      toMs: subject.atMs,
      sources: [
        ...window.map(txnSource),
        ...cards
          .filter((card) => window.some((txn) => txn.cardId === card.cardId))
          .map((card) => ({
            table: CARDS.table,
            id: card.cardId,
            hash: recordHash(CARDS, card as unknown as Record<string, unknown>),
          })),
      ],
      payload: {
        attempts: window.length,
        distinctBins: bins.size,
        distinctCards: new Set(window.map((txn) => txn.cardId)).size,
        declined,
        declineRateBps: Math.round((declined / window.length) * 10_000),
        windowHours: ENUMERATION_WINDOW_MS / HOUR_MS,
      },
    });
  },
};

/**
 * Account age and settled history. Exculpatory: a long-standing account with a record of
 * captured payments is the strongest ordinary argument that an alert is a false positive.
 */
export const customerTenure: Probe = {
  id: "probe.customer_tenure",
  run({ reader, subject }) {
    if (subject.customerId === null) return null;
    const customer = reader.get(CUSTOMERS, subject.customerId);
    if (!customer) return null;

    const priorSettled = reader.query(TRANSACTIONS, "customerId = ? AND atMs < ?", [
      subject.customerId,
      subject.atMs,
    ]);
    const captured = priorSettled.filter((txn) => txn.status === "captured");

    return makeEvidence({
      probe: customerTenure.id,
      subjectType: "customer",
      subjectId: subject.customerId,
      fromMs: customer.signupAtMs,
      toMs: subject.atMs,
      sources: [
        {
          table: CUSTOMERS.table,
          id: customer.customerId,
          hash: recordHash(CUSTOMERS, customer as unknown as Record<string, unknown>),
        },
        ...captured.map(txnSource),
      ],
      payload: {
        accountAgeDays: Math.floor((subject.atMs - customer.signupAtMs) / DAY_MS),
        priorCapturedCount: captured.length,
        priorCapturedValueMinor: captured.reduce((total, txn) => total + txn.amountMinor, 0),
        kycLevel: customer.kycLevel,
      },
    });
  },
};

export const PROBES: readonly Probe[] = [cardEnumeration, customerTenure];

export function probeById(id: string): Probe {
  const probe = PROBES.find((candidate) => candidate.id === id);
  if (!probe) throw new Error(`unknown probe: ${id}`);
  return probe;
}
