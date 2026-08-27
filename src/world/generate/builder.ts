import { digest } from "../../canon/hash.js";
import type { City } from "../../reference/geography.js";
import { CITIES, INDIAN_CITIES } from "../../reference/geography.js";
import type {
  DecoyKind,
  EntityLabel,
  FraudFamily,
  FraudVariant,
  TransactionLabel,
} from "../labels.js";
import { type RandomStream, stream } from "../rng.js";
import type {
  AuthEvent,
  Card,
  Customer,
  Device,
  Dispute,
  IpAddress,
  Merchant,
  ProfileChange,
  Session,
  Transaction,
} from "../schema.js";
import {
  type AsnTemplate,
  BIN_POOLS,
  BROWSER_FAMILIES,
  CARD_BRANDS,
  CONSUMER_ASNS,
  DATACENTER_ASNS,
  DESCRIPTION_POOL,
  EMAIL_DOMAINS,
  INJECTION_PAYLOADS,
  MERCHANT_TEMPLATES,
  MOBILE_ASNS,
  OS_FAMILIES,
} from "./catalog.js";
import { DAY_MS, HOUR_MS, MINUTE_MS, specEndMs, type WorldSpec } from "./config.js";
import { type EntityKind, entityId } from "./ids.js";

/** Late-evening-heavy weekday curve, shared by every actor so hour-of-day cannot separate the classes. */
const HOUR_WEIGHTS = [
  2, 1, 1, 1, 1, 2, 4, 6, 8, 9, 10, 11, 12, 12, 11, 11, 12, 14, 17, 20, 22, 18, 12, 6,
] as const;

export interface TxnLabelInput {
  readonly isFraud: boolean;
  readonly family?: FraudFamily | undefined;
  readonly variant?: FraudVariant | undefined;
  readonly scenarioId?: string | undefined;
  readonly decoyKind?: DecoyKind | undefined;
  readonly archetype?: string | undefined;
}

export interface TxnInput {
  readonly customerId: string | null;
  readonly cardId: string;
  readonly merchantId: string;
  readonly sessionId: string;
  readonly atMs: number;
  readonly amountMinor: number;
  readonly status: Transaction["status"];
  readonly declineReason: Transaction["declineReason"];
  readonly avsResult?: Transaction["avsResult"] | undefined;
  readonly cvvResult?: Transaction["cvvResult"] | undefined;
  readonly threeDsResult: Transaction["threeDsResult"];
  readonly shippingCity: string | null;
}

export interface CardOverrides {
  readonly bin?: string | undefined;
  readonly brand?: Card["brand"] | undefined;
  readonly funding?: Card["funding"] | undefined;
  readonly issuerCountry?: string | undefined;
  readonly replacesCardId?: string | null | undefined;
}

export class WorldBuilder {
  readonly customers = new Map<string, Customer>();
  readonly merchants = new Map<string, Merchant>();
  readonly cards = new Map<string, Card>();
  readonly devices = new Map<string, Device>();
  readonly ips = new Map<string, IpAddress>();
  readonly sessions = new Map<string, Session>();
  readonly authEvents = new Map<string, AuthEvent>();
  readonly profileChanges = new Map<string, ProfileChange>();
  readonly transactions = new Map<string, Transaction>();
  readonly disputes = new Map<string, Dispute>();
  readonly txnLabels = new Map<string, TransactionLabel>();
  readonly entityLabels = new Map<string, EntityLabel>();

  private readonly highDisputeMerchantIds = new Set<string>();

  constructor(readonly spec: WorldSpec) {
    this.buildMerchants();
  }

  stream(...path: (string | number)[]): RandomStream {
    return stream(this.spec.seed, this.spec.idNamespace, ...path);
  }

  id(kind: EntityKind, ...parts: readonly (string | number)[]): string {
    return entityId(this.spec.idNamespace, this.spec.seed, kind, ...parts);
  }

  get endMs(): number {
    return specEndMs(this.spec);
  }

  private buildMerchants(): void {
    for (const [index, template] of MERCHANT_TEMPLATES.entries()) {
      const merchantId = this.id("merchant", index);
      this.merchants.set(merchantId, {
        merchantId,
        name: template.name,
        mcc: template.mcc,
        category: template.category,
        country: "IN",
        avgTicketMinor: template.avgTicketMinor,
        baselineDisputeRateBps: template.baselineDisputeRateBps,
        onboardedAtMs: this.spec.startAtMs - 500 * DAY_MS,
      });
      if (template.baselineDisputeRateBps >= 300) this.highDisputeMerchantIds.add(merchantId);
    }
  }

  /**
   * Instruments a customer could actually present at a given moment. Returns an empty
   * list rather than a not-yet-issued card: callers must skip the event instead of
   * producing a transaction that precedes its own instrument.
   */
  cardsAvailableAt(cardIds: readonly string[], atMs: number): string[] {
    return cardIds.filter((id) => (this.cards.get(id)?.addedAtMs ?? 0) <= atMs);
  }

  merchantsIn(categories: readonly string[]): Merchant[] {
    return [...this.merchants.values()].filter((m) => categories.includes(m.category));
  }

  sampleDayTime(rng: RandomStream, dayStartMs: number): number {
    const hour = rng.weighted(HOUR_WEIGHTS.map((weight, h) => [h, weight] as const));
    return dayStartMs + hour * HOUR_MS + rng.int(0, 59) * MINUTE_MS + rng.int(0, 59_000);
  }

  pickCity(rng: RandomStream, pool: readonly City[] = INDIAN_CITIES): City {
    return rng.weighted(pool.map((city) => [city, city.weight] as const));
  }

  addCustomer(path: readonly (string | number)[], input: Omit<Customer, "customerId">): Customer {
    const customerId = this.id("customer", ...path);
    const customer = { customerId, ...input };
    this.customers.set(customerId, customer);
    return customer;
  }

  addCard(
    path: readonly (string | number)[],
    rng: RandomStream,
    customerId: string,
    addedAtMs: number,
    overrides: CardOverrides = {},
  ): Card {
    const cardId = this.id("card", ...path);
    const brand = overrides.brand ?? rng.weighted(CARD_BRANDS);
    const bins = BIN_POOLS[brand] as readonly string[];
    const card: Card = {
      cardId,
      customerId,
      bin: overrides.bin ?? rng.pick(bins),
      last4: String(rng.int(0, 9_999)).padStart(4, "0"),
      brand,
      funding:
        overrides.funding ??
        rng.weighted([
          ["debit", 55],
          ["credit", 38],
          ["prepaid", 7],
        ]),
      issuerCountry: overrides.issuerCountry ?? "IN",
      addedAtMs,
      replacesCardId: overrides.replacesCardId ?? null,
    };
    this.cards.set(cardId, card);
    return card;
  }

  addDevice(
    path: readonly (string | number)[],
    rng: RandomStream,
    firstSeenAtMs: number,
    overrides: Partial<Pick<Device, "automationSignals" | "osFamily">> = {},
  ): Device {
    const deviceId = this.id("device", ...path);
    const noise = this.stream("noise", "fingerprint", deviceId);
    const device: Device = {
      deviceId,
      fingerprint: noise.chance(this.spec.noise.deviceFingerprintMissingBps)
        ? null
        : digest([deviceId, "fp"]).slice(7, 31),
      osFamily: overrides.osFamily ?? rng.weighted(OS_FAMILIES),
      browserFamily: rng.weighted(BROWSER_FAMILIES),
      firstSeenAtMs,
      automationSignals: overrides.automationSignals ?? rng.chance(200),
    };
    this.devices.set(deviceId, device);
    return device;
  }

  addIp(path: readonly (string | number)[], template: AsnTemplate, city: City | null): IpAddress {
    const ipId = this.id("ip", ...path);
    const noise = this.stream("noise", "geo", ipId);
    const geoMissing =
      template.kind === "mobile" || noise.chance(this.spec.noise.ipGeolocationMissingBps);
    const ip: IpAddress = {
      ipId,
      address: syntheticAddress(ipId),
      asn: template.asn,
      asnOrg: template.org,
      country: geoMissing || !city ? null : city.country,
      city: geoMissing || !city ? null : city.name,
      isDatacenter: template.kind === "datacenter",
      vpnSuspected: template.kind === "datacenter" || noise.chance(this.spec.noise.falseVpnFlagBps),
    };
    this.ips.set(ipId, ip);
    return ip;
  }

  homeIp(path: readonly (string | number)[], rng: RandomStream, city: City): IpAddress {
    return this.addIp(path, rng.pick(CONSUMER_ASNS), city);
  }

  mobileIp(path: readonly (string | number)[], rng: RandomStream, city: City): IpAddress {
    return this.addIp(path, rng.pick(MOBILE_ASNS), city);
  }

  datacenterIp(path: readonly (string | number)[], rng: RandomStream): IpAddress {
    return this.addIp(path, rng.pick(DATACENTER_ASNS), null);
  }

  addSession(path: readonly (string | number)[], input: Omit<Session, "sessionId">): Session {
    const sessionId = this.id("session", ...path);
    const session = { sessionId, ...input };
    this.sessions.set(sessionId, session);
    return session;
  }

  addAuthEvent(
    path: readonly (string | number)[],
    input: Omit<AuthEvent, "authEventId">,
  ): AuthEvent {
    const authEventId = this.id("auth", ...path);
    const event = { authEventId, ...input };
    this.authEvents.set(authEventId, event);
    return event;
  }

  addProfileChange(
    path: readonly (string | number)[],
    input: Omit<ProfileChange, "changeId" | "oldValueDigest" | "newValueDigest">,
  ): ProfileChange {
    const changeId = this.id("change", ...path);
    const change: ProfileChange = {
      changeId,
      ...input,
      oldValueDigest: digest([changeId, "old"]).slice(7, 39),
      newValueDigest: digest([changeId, "new"]).slice(7, 39),
    };
    this.profileChanges.set(changeId, change);
    return change;
  }

  addTransaction(
    path: readonly (string | number)[],
    input: TxnInput,
    label: TxnLabelInput,
  ): Transaction {
    const txnId = this.id("txn", ...path);
    const noise = this.stream("noise", "txn", txnId);
    const avsUnavailable = noise.chance(this.spec.noise.avsUnavailableBps);
    const txn: Transaction = {
      txnId,
      customerId: input.customerId,
      cardId: input.cardId,
      merchantId: input.merchantId,
      sessionId: input.sessionId,
      atMs: input.atMs,
      amountMinor: roundToRupee(input.amountMinor),
      currency: "INR",
      status: input.status,
      declineReason: input.declineReason,
      avsResult: avsUnavailable ? "unavailable" : (input.avsResult ?? "pass"),
      cvvResult: input.cvvResult ?? "pass",
      threeDsResult: input.threeDsResult,
      shippingCity: input.shippingCity,
      description: this.describe(noise),
    };
    this.transactions.set(txnId, txn);

    const decoyKind =
      label.decoyKind ??
      (!label.isFraud && this.highDisputeMerchantIds.has(input.merchantId)
        ? "high_dispute_merchant"
        : undefined);
    this.txnLabels.set(txnId, {
      txnId,
      isFraud: label.isFraud,
      family: label.family ?? null,
      variant: label.variant ?? null,
      scenarioId: label.scenarioId ?? null,
      decoyKind: decoyKind ?? null,
      archetype: label.archetype ?? null,
      atMs: input.atMs,
    });
    return txn;
  }

  private describe(noise: RandomStream): string {
    const injected = noise.chance(this.spec.noise.promptInjectionBps);
    const pool = injected ? INJECTION_PAYLOADS : DESCRIPTION_POOL;
    return noise.pick(pool).replace("%n", String(noise.int(1_000, 99_999)));
  }

  addDispute(path: readonly (string | number)[], input: Omit<Dispute, "disputeId">): Dispute {
    const disputeId = this.id("dispute", ...path);
    const dispute = { disputeId, ...input };
    this.disputes.set(disputeId, dispute);
    return dispute;
  }

  labelEntity(
    entityType: string,
    entityId_: string,
    role: EntityLabel["role"],
    scenarioId: string | null,
  ): void {
    const labelId = this.id("scenario", "entity-label", entityType, entityId_);
    this.entityLabels.set(labelId, {
      labelId,
      entityType,
      entityId: entityId_,
      role,
      scenarioId,
    });
  }

  pickEmailDomain(rng: RandomStream): string {
    return rng.weighted(EMAIL_DOMAINS);
  }

  /**
   * Merchant-level background disputes, keyed per transaction so the draw is
   * independent of which actor produced it. Fraud captures are excluded here; their
   * cardholder-initiated disputes are emitted by the fraud agents themselves.
   */
  applyBackgroundDisputes(): void {
    for (const txn of this.transactions.values()) {
      if (txn.status !== "captured") continue;
      const label = this.txnLabels.get(txn.txnId);
      if (!label || label.isFraud) continue;
      const merchant = this.merchants.get(txn.merchantId);
      if (!merchant) continue;
      const roll = this.stream("noise", "dispute", txn.txnId);
      if (!roll.chance(merchant.baselineDisputeRateBps)) continue;
      this.addDispute(["background", txn.txnId], {
        txnId: txn.txnId,
        openedAtMs: txn.atMs + roll.int(10, 60) * DAY_MS,
        category: roll.weighted([
          ["not_as_described", 40],
          ["not_received", 35],
          ["duplicate", 15],
          ["subscription_cancelled", 10],
        ]),
        outcome: roll.weighted([
          ["won", 45],
          ["lost", 35],
          ["pending", 20],
        ]),
      });
    }
  }
}

function roundToRupee(amountMinor: number): number {
  return Math.max(100, Math.round(amountMinor / 100) * 100);
}

function syntheticAddress(ipId: string): string {
  const hex = digest([ipId]).slice(7);
  const octet = (index: number) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return `10.${octet(0)}.${octet(1)}.${octet(2)}`;
}

export { CITIES, DAY_MS, HOUR_MS, MINUTE_MS };
