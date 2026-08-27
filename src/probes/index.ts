import { type Evidence, makeEvidence } from "../evidence/types.js";
import { containsInjectionAttempt } from "../llm/sanitise.js";
import { isTravelImplausible } from "../reference/geography.js";
import {
  AUTH_EVENTS,
  CARDS,
  CUSTOMERS,
  DEVICES,
  DISPUTES,
  IP_ADDRESSES,
  MERCHANTS,
  PROFILE_CHANGES,
  SESSIONS,
} from "../world/schema.js";
import { type CaseContext, DAY_MS, HOUR_MS, MINUTE_MS, type Probe } from "./context.js";

const ENUMERATION_WINDOW_MS = 6 * HOUR_MS;
const VELOCITY_WINDOW_MS = 24 * HOUR_MS;
const AUTH_WINDOW_MS = 48 * HOUR_MS;
const PROFILE_WINDOW_MS = 7 * DAY_MS;
const HIGH_LIQUIDITY: ReadonlySet<string> = new Set([
  "gift_cards",
  "wallet_topup",
  "gaming",
  "electronics",
]);

function evidence(
  probe: string,
  subjectType: string,
  subjectId: string,
  window: { fromMs: number | null; toMs: number | null },
  payload: Record<string, unknown>,
  sources: ReturnType<CaseContext["ref"]>[],
): Evidence {
  return makeEvidence({
    probe,
    subjectType,
    subjectId,
    fromMs: window.fromMs,
    toMs: window.toMs,
    sources,
    payload: payload as never,
  });
}

/**
 * Distinct BINs attempted and the composition of declines over a short window.
 *
 * One card failing is noise. Many *different* issuers failing from one account inside a
 * few hours is enumeration, because a genuine cardholder does not hold a dozen issuers.
 * The decline mix matters as much as the count: `insufficient_funds` is ordinary life,
 * a wall of `invalid_card` is a list being tested.
 */
export const cardEnumeration: Probe = {
  id: "probe.card_enumeration",
  cost: 3,
  run(context) {
    const window = context.historyWindow(ENUMERATION_WINDOW_MS);
    if (window.length === 0) return null;

    const cards = new Map(context.cardsOfCustomer().map((card) => [card.cardId, card]));
    const bins = new Set<string>();
    for (const txn of window) {
      const bin = cards.get(txn.cardId)?.bin;
      if (bin) bins.add(bin);
    }

    const declined = window.filter((txn) => txn.status === "declined");
    const hardDeclines = declined.filter((txn) =>
      ["invalid_card", "do_not_honour", "suspected_fraud", "expired_card"].includes(
        txn.declineReason ?? "",
      ),
    ).length;

    const sources = [
      ...window.map((txn) => context.txnRef(txn)),
      ...[...bins]
        .map((bin) => [...cards.values()].find((card) => card.bin === bin))
        .filter((card): card is NonNullable<typeof card> => card !== undefined)
        .map((card) => context.ref(CARDS, card as unknown as Record<string, unknown>)),
    ];

    return evidence(
      cardEnumeration.id,
      "customer",
      context.subject.customerId ?? context.subject.txnId,
      { fromMs: context.asOfMs - ENUMERATION_WINDOW_MS, toMs: context.asOfMs },
      {
        attempts: window.length,
        distinctBins: bins.size,
        distinctCards: new Set(window.map((txn) => txn.cardId)).size,
        declined: declined.length,
        hardDeclines,
        declineRateBps: Math.round((declined.length / window.length) * 10_000),
        windowHours: ENUMERATION_WINDOW_MS / HOUR_MS,
        subjectCaptured: context.subject.status === "captured",
      },
      sources,
    );
  },
};

/** Transaction count and value against this account's own established rhythm. */
export const velocityBaseline: Probe = {
  id: "probe.velocity_baseline",
  cost: 2,
  run(context) {
    const recent = context.historyWindow(VELOCITY_WINDOW_MS);
    const prior = context.priorTransactions();
    if (prior.length === 0) return null;

    const spanDays = Math.max(1, (context.asOfMs - (prior[0] as { atMs: number }).atMs) / DAY_MS);
    const dailyBaseline = prior.length / spanDays;
    const ratioBps =
      dailyBaseline > 0 ? Math.round((recent.length / dailyBaseline) * 10_000) : 10_000;

    return evidence(
      velocityBaseline.id,
      "customer",
      context.subject.customerId ?? context.subject.txnId,
      { fromMs: context.asOfMs - VELOCITY_WINDOW_MS, toMs: context.asOfMs },
      {
        transactionsLast24h: recent.length,
        historicalDailyRateBps: Math.round(dailyBaseline * 10_000),
        ratioToBaselineBps: ratioBps,
        observedDays: Math.round(spanDays),
      },
      recent.map((txn) => context.txnRef(txn)),
    );
  },
};

/** Amount against both the merchant's typical ticket and this customer's own history. */
export const amountContext: Probe = {
  id: "probe.amount_context",
  cost: 1,
  run(context) {
    const merchant = context.merchant();
    if (!merchant) return null;
    const prior = context.priorTransactions().filter((txn) => txn.status === "captured");
    const sorted = prior.map((txn) => txn.amountMinor).sort((a, b) => a - b);
    const median = sorted.length > 0 ? (sorted[Math.floor(sorted.length / 2)] as number) : 0;

    return evidence(
      amountContext.id,
      "transaction",
      context.subject.txnId,
      { fromMs: null, toMs: context.asOfMs },
      {
        amountMinor: context.subject.amountMinor,
        merchantTicketMinor: merchant.avgTicketMinor,
        ticketRatioBps: Math.round(
          (context.subject.amountMinor / merchant.avgTicketMinor) * 10_000,
        ),
        customerMedianMinor: median,
        customerRatioBps:
          median > 0 ? Math.round((context.subject.amountMinor / median) * 10_000) : 0,
        priorCaptures: prior.length,
      },
      [
        context.ref(MERCHANTS, merchant as unknown as Record<string, unknown>),
        context.txnRef(context.subject),
      ],
    );
  },
};

/** How long this account has used the device behind the transaction. */
export const deviceHistory: Probe = {
  id: "probe.device_history",
  cost: 3,
  run(context) {
    const session = context.subjectSession();
    if (!session) return null;
    const device = context.device(session.deviceId);
    if (!device) return null;

    const priorSessions = context
      .sessionsOfCustomer(365 * DAY_MS)
      .filter((s) => s.deviceId === device.deviceId && s.startedAtMs < session.startedAtMs);
    const firstUse = priorSessions[0]?.startedAtMs ?? session.startedAtMs;

    return evidence(
      deviceHistory.id,
      "device",
      device.deviceId,
      { fromMs: device.firstSeenAtMs, toMs: context.asOfMs },
      {
        knownToAccountDays: Math.floor((context.asOfMs - firstUse) / DAY_MS),
        priorSessionsOnDevice: priorSessions.length,
        deviceAgeDays: Math.floor((context.asOfMs - device.firstSeenAtMs) / DAY_MS),
        fingerprintAvailable: device.fingerprint !== null,
        automationSignals: device.automationSignals,
      },
      [
        context.ref(DEVICES, device as unknown as Record<string, unknown>),
        context.ref(SESSIONS, session as unknown as Record<string, unknown>),
        ...priorSessions
          .slice(0, 20)
          .map((s) => context.ref(SESSIONS, s as unknown as Record<string, unknown>)),
      ],
    );
  },
};

/**
 * How many distinct accounts share this device, and for how long.
 *
 * Sharing alone is not suspicious — households do it for years. What separates a
 * household from a mule cluster is stability: co-occurrence measured in months rather
 * than days.
 */
export const deviceSharing: Probe = {
  id: "probe.device_sharing",
  cost: 4,
  run(context) {
    const session = context.subjectSession();
    if (!session) return null;
    const { accounts, sessions } = context.accountsOnDevice(session.deviceId);
    if (accounts.size <= 1) return null;

    const firstSeen = sessions[0]?.startedAtMs ?? context.asOfMs;
    const firstByAccount = new Map<string, number>();
    for (const s of sessions) {
      if (!s.customerId) continue;
      if (!firstByAccount.has(s.customerId)) firstByAccount.set(s.customerId, s.startedAtMs);
    }
    const spreadDays =
      (Math.max(...firstByAccount.values()) - Math.min(...firstByAccount.values())) / DAY_MS;

    const homeCities = new Set(
      [...accounts]
        .map((id) => context.customerOf(id)?.homeCity)
        .filter((city): city is string => city !== undefined),
    );

    return evidence(
      deviceSharing.id,
      "device",
      session.deviceId,
      { fromMs: firstSeen, toMs: context.asOfMs },
      {
        accountsOnDevice: accounts.size,
        coOccurrenceDays: Math.floor((context.asOfMs - firstSeen) / DAY_MS),
        accountArrivalSpreadDays: Math.floor(spreadDays),
        distinctHomeCities: homeCities.size,
      },
      [
        context.ref(SESSIONS, session as unknown as Record<string, unknown>),
        ...sessions
          .slice(0, 30)
          .map((s) => context.ref(SESSIONS, s as unknown as Record<string, unknown>)),
      ],
    );
  },
};

/** Network reputation: datacentre ranges, VPN classification, missing geolocation. */
export const ipReputation: Probe = {
  id: "probe.ip_reputation",
  cost: 2,
  run(context) {
    const session = context.subjectSession();
    if (!session) return null;
    const ip = context.ip(session.ipId);
    if (!ip) return null;

    const priorOnIp = context
      .sessionsOfCustomer(180 * DAY_MS)
      .filter((s) => s.ipId === ip.ipId && s.startedAtMs < session.startedAtMs).length;

    return evidence(
      ipReputation.id,
      "ip",
      ip.ipId,
      { fromMs: null, toMs: context.asOfMs },
      {
        isDatacenter: ip.isDatacenter,
        vpnSuspected: ip.vpnSuspected,
        geolocationAvailable: ip.country !== null,
        asnOrg: ip.asnOrg,
        priorSessionsFromThisAddress: priorOnIp,
      },
      [
        context.ref(IP_ADDRESSES, ip as unknown as Record<string, unknown>),
        context.ref(SESSIONS, session as unknown as Record<string, unknown>),
      ],
    );
  },
};

/**
 * Accounts sharing a network path.
 *
 * A university NAT legitimately carries hundreds of unrelated students, so raw count is
 * a poor signal. The probe reports the ASN alongside it so the verifier can distinguish
 * institutional infrastructure from a cluster on one consumer line.
 */
export const ipSharing: Probe = {
  id: "probe.ip_sharing",
  cost: 3,
  run(context) {
    const session = context.subjectSession();
    if (!session) return null;
    const ip = context.ip(session.ipId);
    if (!ip) return null;
    const { accounts } = context.accountsOnIp(ip.ipId);
    if (accounts.size <= 1) return null;

    return evidence(
      ipSharing.id,
      "ip",
      ip.ipId,
      { fromMs: null, toMs: context.asOfMs },
      {
        accountsOnAddress: accounts.size,
        asn: ip.asn,
        asnOrg: ip.asnOrg,
        isDatacenter: ip.isDatacenter,
      },
      [
        context.ref(IP_ADDRESSES, ip as unknown as Record<string, unknown>),
        context.ref(SESSIONS, session as unknown as Record<string, unknown>),
      ],
    );
  },
};

/** Whether consecutive authenticated locations are reachable in the elapsed time. */
export const geoVelocity: Probe = {
  id: "probe.geo_velocity",
  cost: 3,
  run(context) {
    const session = context.subjectSession();
    if (!session) return null;
    const here = context.ip(session.ipId);
    if (!here?.city) return null;

    const earlier = context
      .sessionsOfCustomer(7 * DAY_MS)
      .filter((s) => s.startedAtMs < session.startedAtMs)
      .reverse();

    for (const candidate of earlier) {
      const there = context.ip(candidate.ipId);
      if (!there?.city || there.city === here.city) continue;
      const elapsedMinutes = (session.startedAtMs - candidate.endedAtMs) / MINUTE_MS;
      const implausible = isTravelImplausible(there.city, here.city, elapsedMinutes);
      return evidence(
        geoVelocity.id,
        "customer",
        context.subject.customerId ?? context.subject.txnId,
        { fromMs: candidate.startedAtMs, toMs: context.asOfMs },
        {
          fromCity: there.city,
          toCity: here.city,
          elapsedMinutes: Math.floor(elapsedMinutes),
          // Null when either endpoint is unlocatable: undecidable, never exculpatory.
          implausible: implausible === null ? "unknown" : implausible ? "yes" : "no",
        },
        [
          context.ref(IP_ADDRESSES, there as unknown as Record<string, unknown>),
          context.ref(IP_ADDRESSES, here as unknown as Record<string, unknown>),
          context.ref(SESSIONS, candidate as unknown as Record<string, unknown>),
          context.ref(SESSIONS, session as unknown as Record<string, unknown>),
        ],
      );
    }
    return null;
  },
};

/** Authentication outcomes around the transaction, including step-up results. */
export const authOutcomes: Probe = {
  id: "probe.auth_outcomes",
  cost: 2,
  run(context) {
    const events = context.authEvents(AUTH_WINDOW_MS);
    if (events.length === 0 && context.subject.threeDsResult === "not_requested") return null;

    const failedLogins = events.filter((e) => e.kind === "login" && e.outcome === "failure").length;
    const stepUpFailures = events.filter(
      (e) =>
        (e.kind === "otp_challenge" || e.kind === "three_ds_challenge") && e.outcome !== "success",
    ).length;

    return evidence(
      authOutcomes.id,
      "customer",
      context.subject.customerId ?? context.subject.txnId,
      { fromMs: context.asOfMs - AUTH_WINDOW_MS, toMs: context.asOfMs },
      {
        failedLogins,
        stepUpFailures,
        passwordResets: events.filter((e) => e.kind === "password_reset").length,
        threeDsResult: context.subject.threeDsResult,
        avsResult: context.subject.avsResult,
        cvvResult: context.subject.cvvResult,
      },
      [
        ...events
          .slice(0, 30)
          .map((e) => context.ref(AUTH_EVENTS, e as unknown as Record<string, unknown>)),
        context.txnRef(context.subject),
      ],
    );
  },
};

/** Contact-detail churn shortly before the payment — the classic takeover signature. */
export const profileChurn: Probe = {
  id: "probe.profile_churn",
  cost: 2,
  run(context) {
    const changes = context.profileChanges(PROFILE_WINDOW_MS);
    if (changes.length === 0) return null;
    const latest = changes[changes.length - 1] as { atMs: number; field: string };

    return evidence(
      profileChurn.id,
      "customer",
      context.subject.customerId ?? context.subject.txnId,
      { fromMs: context.asOfMs - PROFILE_WINDOW_MS, toMs: context.asOfMs },
      {
        changesInWindow: changes.length,
        hoursSinceLatest: Math.floor((context.asOfMs - latest.atMs) / HOUR_MS),
        fieldsChanged: [...new Set(changes.map((c) => c.field))].sort(),
        contactDetailChanged: changes.some(
          (c) => c.field === "email" || c.field === "phone" || c.field === "shipping_address",
        ),
      },
      changes.map((c) => context.ref(PROFILE_CHANGES, c as unknown as Record<string, unknown>)),
    );
  },
};

/** Account standing: tenure, verification and settled volume. Exculpatory by nature. */
export const customerTenure: Probe = {
  id: "probe.customer_tenure",
  cost: 1,
  run(context) {
    const customer = context.customer();
    if (!customer) return null;
    const prior = context.priorTransactions();
    const captured = prior.filter((txn) => txn.status === "captured");

    return evidence(
      customerTenure.id,
      "customer",
      customer.customerId,
      { fromMs: customer.signupAtMs, toMs: context.asOfMs },
      {
        accountAgeDays: Math.floor((context.asOfMs - customer.signupAtMs) / DAY_MS),
        kycLevel: customer.kycLevel,
        priorCapturedCount: captured.length,
        priorCapturedValueMinor: captured.reduce((sum, txn) => sum + txn.amountMinor, 0),
        distinctMerchantsUsed: new Set(captured.map((txn) => txn.merchantId)).size,
      },
      [
        context.ref(CUSTOMERS, customer as unknown as Record<string, unknown>),
        ...captured.slice(0, 40).map((txn) => context.txnRef(txn)),
      ],
    );
  },
};

/** Prior relationship with this merchant. Strongly exculpatory when it exists. */
export const merchantRelationship: Probe = {
  id: "probe.merchant_relationship",
  cost: 1,
  run(context) {
    const prior = context
      .priorTransactions()
      .filter((txn) => txn.merchantId === context.subject.merchantId);
    if (prior.length === 0) return null;
    const captured = prior.filter((txn) => txn.status === "captured");

    return evidence(
      merchantRelationship.id,
      "customer",
      context.subject.customerId ?? context.subject.txnId,
      { fromMs: (prior[0] as { atMs: number }).atMs, toMs: context.asOfMs },
      {
        priorTransactionsWithMerchant: prior.length,
        priorCaptures: captured.length,
        relationshipDays: Math.floor(
          (context.asOfMs - (prior[0] as { atMs: number }).atMs) / DAY_MS,
        ),
      },
      prior.slice(0, 30).map((txn) => context.txnRef(txn)),
    );
  },
};

/** Static merchant context: how liquid the category is and the merchant's own baseline. */
export const merchantContext: Probe = {
  id: "probe.merchant_context",
  cost: 1,
  run(context) {
    const merchant = context.merchant();
    if (!merchant) return null;
    return evidence(
      merchantContext.id,
      "merchant",
      merchant.merchantId,
      { fromMs: null, toMs: context.asOfMs },
      {
        category: merchant.category,
        highLiquidity: HIGH_LIQUIDITY.has(merchant.category),
        baselineDisputeRateBps: merchant.baselineDisputeRateBps,
      },
      [context.ref(MERCHANTS, merchant as unknown as Record<string, unknown>)],
    );
  },
};

/** Whether the destination address matches where this customer normally receives goods. */
export const shippingConsistency: Probe = {
  id: "probe.shipping_consistency",
  cost: 1,
  run(context) {
    if (context.subject.shippingCity === null) return null;
    const customer = context.customer();
    if (!customer) return null;
    const priorCities = new Set(
      context
        .priorTransactions()
        .map((txn) => txn.shippingCity)
        .filter((city): city is string => city !== null),
    );

    return evidence(
      shippingConsistency.id,
      "transaction",
      context.subject.txnId,
      { fromMs: null, toMs: context.asOfMs },
      {
        shippingCity: context.subject.shippingCity,
        homeCity: customer.homeCity,
        matchesHome: context.subject.shippingCity === customer.homeCity,
        seenBefore: priorCities.has(context.subject.shippingCity),
        distinctPriorCities: priorCities.size,
      },
      [
        context.ref(CUSTOMERS, customer as unknown as Record<string, unknown>),
        context.txnRef(context.subject),
      ],
    );
  },
};

/** Dispute history on earlier, settled transactions only. */
export const disputeHistory: Probe = {
  id: "probe.dispute_history",
  cost: 2,
  run(context) {
    const prior = context.priorDisputes();
    const settled = context.priorTransactions();
    if (settled.length === 0) return null;

    return evidence(
      disputeHistory.id,
      "customer",
      context.subject.customerId ?? context.subject.txnId,
      { fromMs: null, toMs: context.asOfMs },
      {
        priorDisputes: prior.length,
        priorTransactions: settled.length,
        disputeRateBps: Math.round((prior.length / settled.length) * 10_000),
        unauthorisedClaims: prior.filter((d) => d.category === "unauthorised").length,
      },
      // Absence of disputes is itself evidence, so the transactions that were searched
      // are cited even when none of them was ever challenged.
      [
        ...prior.map((d) => context.ref(DISPUTES, d as unknown as Record<string, unknown>)),
        ...settled.slice(0, 40).map((txn) => context.txnRef(txn)),
      ],
    );
  },
};

/**
 * Free text supplied at checkout is attacker-controlled. This surfaces an instruction
 * shaped payload as evidence in its own right rather than letting it reach a model.
 */
export const contentSafety: Probe = {
  id: "probe.content_safety",
  cost: 1,
  run(context) {
    const finding = containsInjectionAttempt(context.subject.description);
    if (!finding.detected) return null;
    return evidence(
      contentSafety.id,
      "transaction",
      context.subject.txnId,
      { fromMs: null, toMs: context.asOfMs },
      { patterns: finding.patterns, characters: context.subject.description.length },
      [context.txnRef(context.subject)],
    );
  },
};

export const PROBES: readonly Probe[] = [
  cardEnumeration,
  velocityBaseline,
  amountContext,
  deviceHistory,
  deviceSharing,
  ipReputation,
  ipSharing,
  geoVelocity,
  authOutcomes,
  profileChurn,
  customerTenure,
  merchantRelationship,
  merchantContext,
  shippingConsistency,
  disputeHistory,
  contentSafety,
];

export const FULL_SWEEP: readonly string[] = PROBES.map((probe) => probe.id);

export function probeById(id: string): Probe {
  const probe = PROBES.find((candidate) => candidate.id === id);
  if (!probe) throw new Error(`unknown probe: ${id}`);
  return probe;
}

export { CaseContext } from "./context.js";
