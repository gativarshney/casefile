import type { Evidence, SourceRef } from "../evidence/types.js";
import {
  AUTH_EVENTS,
  type AuthEvent,
  CARDS,
  type Card,
  CUSTOMERS,
  type Customer,
  DEVICES,
  type Device,
  DISPUTES,
  type Dispute,
  type ErasedRecordType,
  IP_ADDRESSES,
  type IpAddress,
  MERCHANTS,
  type Merchant,
  PROFILE_CHANGES,
  type ProfileChange,
  recordHash,
  SESSIONS,
  type Session,
  TRANSACTIONS,
  type Transaction,
} from "../world/schema.js";
import type { WorldReader } from "../world/store.js";

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

/**
 * Everything a probe may look at, resolved once per case.
 *
 * The `asOfMs` cutoff is load-bearing: an authorisation-time decision may not consult
 * anything that had not happened yet. Every accessor here filters on it, so a probe
 * cannot accidentally read the future — which is what makes friendly fraud genuinely
 * hard rather than artificially solvable.
 */
export class CaseContext {
  readonly asOfMs: number;
  private readonly sourceRefs = new Map<string, SourceRef>();

  constructor(
    private readonly reader: WorldReader,
    readonly subject: Transaction,
  ) {
    this.asOfMs = subject.atMs;
  }

  ref(type: ErasedRecordType, record: Record<string, unknown>): SourceRef {
    const id = String(record[type.primaryKey]);
    const key = `${type.table}:${id}`;
    const existing = this.sourceRefs.get(key);
    if (existing) return existing;
    const created: SourceRef = { table: type.table, id, hash: recordHash(type, record) };
    this.sourceRefs.set(key, created);
    return created;
  }

  txnRef(txn: Transaction): SourceRef {
    return this.ref(TRANSACTIONS, txn as unknown as Record<string, unknown>);
  }

  customer(): Customer | undefined {
    if (this.subject.customerId === null) return undefined;
    return this.reader.get(CUSTOMERS, this.subject.customerId);
  }

  merchant(): Merchant | undefined {
    return this.reader.get(MERCHANTS, this.subject.merchantId);
  }

  card(cardId: string): Card | undefined {
    return this.reader.get(CARDS, cardId);
  }

  session(sessionId: string): Session | undefined {
    return this.reader.get(SESSIONS, sessionId);
  }

  subjectSession(): Session | undefined {
    return this.session(this.subject.sessionId);
  }

  device(deviceId: string): Device | undefined {
    return this.reader.get(DEVICES, deviceId);
  }

  ip(ipId: string): IpAddress | undefined {
    return this.reader.get(IP_ADDRESSES, ipId);
  }

  cardsOfCustomer(): Card[] {
    if (this.subject.customerId === null) return [];
    return this.reader
      .query(CARDS, "customerId = ?", [this.subject.customerId])
      .filter((card) => card.addedAtMs <= this.asOfMs);
  }

  /** Transactions on this account up to and including the subject. */
  historyWindow(windowMs: number): Transaction[] {
    if (this.subject.customerId === null) return [];
    return this.reader
      .query(TRANSACTIONS, "customerId = ? AND atMs <= ? AND atMs >= ?", [
        this.subject.customerId,
        this.asOfMs,
        this.asOfMs - windowMs,
      ])
      .sort((a, b) => a.atMs - b.atMs);
  }

  /** Everything on this account strictly before the subject. */
  priorTransactions(): Transaction[] {
    if (this.subject.customerId === null) return [];
    return this.reader
      .query(TRANSACTIONS, "customerId = ? AND atMs < ?", [this.subject.customerId, this.asOfMs])
      .sort((a, b) => a.atMs - b.atMs);
  }

  sessionsOfCustomer(windowMs: number): Session[] {
    if (this.subject.customerId === null) return [];
    return this.reader
      .query(SESSIONS, "customerId = ? AND startedAtMs <= ? AND startedAtMs >= ?", [
        this.subject.customerId,
        this.asOfMs,
        this.asOfMs - windowMs,
      ])
      .sort((a, b) => a.startedAtMs - b.startedAtMs);
  }

  authEvents(windowMs: number): AuthEvent[] {
    if (this.subject.customerId === null) return [];
    return this.reader
      .query(AUTH_EVENTS, "customerId = ? AND atMs <= ? AND atMs >= ?", [
        this.subject.customerId,
        this.asOfMs,
        this.asOfMs - windowMs,
      ])
      .sort((a, b) => a.atMs - b.atMs);
  }

  profileChanges(windowMs: number): ProfileChange[] {
    if (this.subject.customerId === null) return [];
    return this.reader
      .query(PROFILE_CHANGES, "customerId = ? AND atMs <= ? AND atMs >= ?", [
        this.subject.customerId,
        this.asOfMs,
        this.asOfMs - windowMs,
      ])
      .sort((a, b) => a.atMs - b.atMs);
  }

  /**
   * Disputes already resolved or filed before this authorisation. The dispute belonging
   * to the subject transaction is unreachable by construction, because it is opened
   * weeks later — reading it would be reading the future.
   */
  priorDisputes(): Dispute[] {
    const priorIds = new Set(this.priorTransactions().map((txn) => txn.txnId));
    if (priorIds.size === 0) return [];
    return this.reader
      .all(DISPUTES)
      .filter((dispute) => priorIds.has(dispute.txnId) && dispute.openedAtMs < this.asOfMs);
  }

  /** Distinct accounts seen on a device up to now. */
  accountsOnDevice(deviceId: string): { accounts: Set<string>; sessions: Session[] } {
    const sessions = this.reader
      .query(SESSIONS, "deviceId = ? AND startedAtMs <= ?", [deviceId, this.asOfMs])
      .sort((a, b) => a.startedAtMs - b.startedAtMs);
    const accounts = new Set<string>();
    for (const session of sessions) if (session.customerId) accounts.add(session.customerId);
    return { accounts, sessions };
  }

  accountsOnIp(ipId: string): { accounts: Set<string>; sessions: Session[] } {
    const sessions = this.reader
      .query(SESSIONS, "ipId = ? AND startedAtMs <= ?", [ipId, this.asOfMs])
      .sort((a, b) => a.startedAtMs - b.startedAtMs);
    const accounts = new Set<string>();
    for (const session of sessions) if (session.customerId) accounts.add(session.customerId);
    return { accounts, sessions };
  }

  customerOf(customerId: string): Customer | undefined {
    return this.reader.get(CUSTOMERS, customerId);
  }

  refs(): SourceRef[] {
    return [...this.sourceRefs.values()];
  }
}

export interface Probe {
  readonly id: string;
  readonly cost: number;
  run(context: CaseContext): Evidence | null;
}
