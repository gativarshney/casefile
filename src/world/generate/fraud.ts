import { CITIES } from "../../reference/geography.js";
import type { FraudFamily, FraudVariant } from "../labels.js";
import type { Merchant } from "../schema.js";
import type { WorldBuilder } from "./builder.js";
import { HIGH_LIQUIDITY } from "./catalog.js";

const SHIPPED_CATEGORIES: ReadonlySet<string> = new Set([
  "electronics",
  "fashion",
  "grocery",
  "food_delivery",
]);

import { DAY_MS, HOUR_MS, MINUTE_MS } from "./config.js";
import type { LegitimatePopulation, Person } from "./legit.js";

interface FraudContext {
  readonly family: FraudFamily;
  readonly variant: FraudVariant;
  readonly scenarioId: string;
}

export function buildFraud(b: WorldBuilder, legit: LegitimatePopulation): void {
  let index = 0;
  const scenario = (family: FraudFamily, variant: FraudVariant): FraudContext => {
    index += 1;
    return { family, variant, scenarioId: b.id("scenario", family, variant, index) };
  };

  for (let n = 0; n < b.spec.fraud.cardTestingBurst; n += 1) {
    cardTesting(b, scenario("card_testing", "burst"), n, "burst");
  }
  for (let n = 0; n < b.spec.fraud.cardTestingSlowLow; n += 1) {
    cardTesting(b, scenario("card_testing", "slow_low"), n, "slow_low");
  }
  for (let n = 0; n < b.spec.fraud.atoCredentialStuffing; n += 1) {
    accountTakeover(
      b,
      legit,
      scenario("account_takeover", "credential_stuffing"),
      n,
      "credential_stuffing",
    );
  }
  for (let n = 0; n < b.spec.fraud.atoSessionHijack; n += 1) {
    accountTakeover(b, legit, scenario("account_takeover", "session_hijack"), n, "session_hijack");
  }
  for (let n = 0; n < b.spec.fraud.ringSharedInfrastructure; n += 1) {
    abuseRing(b, scenario("abuse_ring", "shared_infrastructure"), n, "shared_infrastructure");
  }
  for (let n = 0; n < b.spec.fraud.ringTimingOnly; n += 1) {
    abuseRing(b, scenario("abuse_ring", "timing_only"), n, "timing_only");
  }
  for (let n = 0; n < b.spec.fraud.friendlyBuyersRemorse; n += 1) {
    friendlyFraud(b, legit, scenario("friendly_fraud", "buyers_remorse"), n, "buyers_remorse");
  }
  for (let n = 0; n < b.spec.fraud.friendlyFamilyMember; n += 1) {
    friendlyFraud(b, legit, scenario("friendly_fraud", "family_member"), n, "family_member");
  }
}

function liquidMerchants(b: WorldBuilder): Merchant[] {
  return b.merchantsIn(HIGH_LIQUIDITY);
}

/**
 * Validate stolen numbers then monetise the live ones. `burst` compresses everything
 * into minutes on one device; `slow_low` spreads the same attack over days across
 * rotating devices, so density carries no signal and only the BIN/decline composition
 * survives — the mechanism the held-out generalisation test depends on.
 */
function cardTesting(
  b: WorldBuilder,
  ctx: FraudContext,
  n: number,
  variant: "burst" | "slow_low",
): void {
  const path = ["fraud", ctx.variant, n] as const;
  const rng = b.stream(...path);
  const city = b.pickCity(rng);
  const merchants = liquidMerchants(b);
  const attempts = variant === "burst" ? rng.int(10, 18) : rng.int(28, 46);
  const startDay = rng.int(2, b.spec.days - 12);
  const startMs = b.sampleDayTime(rng, b.spec.startAtMs + startDay * DAY_MS);

  // Aged, KYC-passed accounts are bought as readily as fresh ones; account age must not
  // be a proxy for the label.
  const accountAgeDays = rng.weighted([
    [rng.int(0, 10), 25],
    [rng.int(20, 160), 30],
    [rng.int(160, 500), 25],
    [rng.int(500, 900), 20],
  ]);
  const customerId = b.addCustomer(path, {
    signupAtMs: startMs - accountAgeDays * DAY_MS - rng.int(1, 20) * HOUR_MS,
    homeCountry: "IN",
    homeCity: city.name,
    emailDomain: b.pickEmailDomain(rng),
    kycLevel: rng.weighted([
      [0, 55],
      [1, 30],
      [2, 15],
    ]),
  }).customerId;
  b.labelEntity("customer", customerId, "fraudster", ctx.scenarioId);

  const deviceAgeDays = rng.int(0, 400);
  const burstDevice =
    variant === "burst"
      ? b.addDevice([...path, "device"], rng, startMs - deviceAgeDays * DAY_MS, {
          automationSignals: rng.chance(6_000),
        })
      : null;
  const burstIp = variant === "burst" ? b.homeIp([...path, "ip"], rng, city) : null;

  const successIndex = attempts - rng.int(1, 3);
  // Not every actor cashes out immediately. Waiting until the testing window has closed
  // is an ordinary countermeasure, and it removes the strongest single signal — so a
  // detector that leans only on "a capture among declines" misses these entirely.
  const delayedMonetisation = rng.chance(3_500);
  const monetisationDelayMs = delayedMonetisation ? rng.int(8, 30) * HOUR_MS : 0;
  // A cautious actor works a narrower slice of the list, so issuer spread is thinner.
  const binPoolSize = rng.weighted([
    [3, 30],
    [6, 40],
    [12, 30],
  ]);
  for (let a = 0; a < attempts; a += 1) {
    const attemptRng = b.stream(...path, "attempt", a);
    const atMs =
      variant === "burst"
        ? startMs + a * attemptRng.int(20, 90) * 1_000
        : b.sampleDayTime(attemptRng, b.spec.startAtMs + (startDay + Math.floor(a / 5)) * DAY_MS);

    const device =
      burstDevice ??
      b.addDevice([...path, "device", a], attemptRng, atMs - attemptRng.int(0, 300) * DAY_MS, {
        automationSignals: attemptRng.chance(3_000),
      });
    const ip = burstIp ?? b.homeIp([...path, "ip", a], attemptRng, b.pickCity(attemptRng));

    const session = b.addSession([...path, "session", a], {
      customerId,
      deviceId: device.deviceId,
      ipId: ip.ipId,
      startedAtMs: atMs - attemptRng.int(2, 15) * MINUTE_MS,
      endedAtMs: atMs + attemptRng.int(1, 10) * MINUTE_MS,
      channel: "web",
    });

    const card = b.addCard(
      [...path, "card", a % binPoolSize],
      attemptRng,
      customerId,
      atMs - attemptRng.int(0, 620) * DAY_MS,
      {
        funding: "credit",
        issuerCountry: attemptRng.chance(2_500) ? attemptRng.pick(["US", "GB", "AE"]) : "IN",
      },
    );

    const succeeded = a >= successIndex;
    const merchant = attemptRng.pick(merchants);
    b.addTransaction(
      [...path, "txn", a],
      {
        customerId,
        cardId: card.cardId,
        merchantId: merchant.merchantId,
        sessionId: session.sessionId,
        atMs: succeeded ? atMs + monetisationDelayMs : atMs,
        amountMinor: succeeded
          ? attemptRng.lognormalInt(merchant.avgTicketMinor, 0.55, 2_000)
          : attemptRng.int(1, 6) * 100,
        status: succeeded ? "captured" : "declined",
        declineReason: succeeded
          ? null
          : attemptRng.weighted([
              ["invalid_card", 45],
              ["do_not_honour", 35],
              ["suspected_fraud", 12],
              ["expired_card", 8],
            ]),
        avsResult: succeeded
          ? attemptRng.weighted([
              ["pass", 45],
              ["unavailable", 55],
            ])
          : "fail",
        cvvResult: succeeded
          ? "pass"
          : attemptRng.weighted([
              ["fail", 80],
              ["pass", 20],
            ]),
        threeDsResult: "not_requested",
        shippingCity: null,
      },
      { isFraud: succeeded, family: ctx.family, variant: ctx.variant, scenarioId: ctx.scenarioId },
    );
  }
}

/**
 * Drain a real account. `credential_stuffing` leaves failed logins and a step-up
 * failure; `session_hijack` has neither, so the usual authentication signal is simply
 * absent and only device novelty against an established account plus a shipping change
 * remain.
 */
function accountTakeover(
  b: WorldBuilder,
  legit: LegitimatePopulation,
  ctx: FraudContext,
  n: number,
  variant: "credential_stuffing" | "session_hijack",
): void {
  const path = ["fraud", ctx.variant, n] as const;
  const rng = b.stream(...path);
  const pool = legit.victimPool;
  if (pool.length === 0) return;
  const victim = pool[rng.int(0, pool.length - 1)] as Person;
  const atMs = b.sampleDayTime(rng, b.spec.startAtMs + rng.int(5, b.spec.days - 3) * DAY_MS);
  const victimCards = b.cardsAvailableAt(victim.cardIds, atMs);
  if (victimCards.length === 0) return;
  b.labelEntity("customer", victim.customerId, "victim", ctx.scenarioId);
  const attackerCity = b.pickCity(rng, CITIES);
  const device = b.addDevice([...path, "device"], rng, atMs - rng.int(0, 350) * DAY_MS, {
    automationSignals: rng.chance(2_000),
  });
  const ip = b.homeIp([...path, "ip"], rng, attackerCity);

  const session = b.addSession([...path, "session"], {
    customerId: victim.customerId,
    deviceId: device.deviceId,
    ipId: ip.ipId,
    startedAtMs: atMs - rng.int(6, 22) * MINUTE_MS,
    endedAtMs: atMs + rng.int(1, 10) * MINUTE_MS,
    channel: "web",
  });

  if (variant === "credential_stuffing") {
    const failures = rng.int(2, 5);
    for (let f = 0; f < failures; f += 1) {
      b.addAuthEvent([...path, "login-fail", f], {
        sessionId: session.sessionId,
        customerId: victim.customerId,
        kind: "login",
        outcome: "failure",
        atMs: session.startedAtMs + f * MINUTE_MS,
      });
    }
    b.addAuthEvent([...path, "login-ok"], {
      sessionId: session.sessionId,
      customerId: victim.customerId,
      kind: "login",
      outcome: "success",
      atMs: session.startedAtMs + (failures + 1) * MINUTE_MS,
    });
  } else {
    b.addAuthEvent([...path, "login-ok"], {
      sessionId: session.sessionId,
      customerId: victim.customerId,
      kind: "login",
      outcome: "success",
      atMs: session.startedAtMs,
    });
  }

  // Changing contact details first is common but not universal; an attacker in a hurry
  // simply spends, leaving the profile untouched.
  const changesProfile = rng.chance(6_000);
  const changes = changesProfile
    ? rng.shuffle(["email", "phone", "shipping_address"] as const).slice(0, rng.int(1, 2))
    : [];
  for (const [i, field] of changes.entries()) {
    b.addProfileChange([...path, "change", i], {
      customerId: victim.customerId,
      sessionId: session.sessionId,
      field,
      atMs: atMs - (5 - i) * MINUTE_MS,
    });
  }

  const merchant = rng.pick(liquidMerchants(b));
  const stepUpFails = variant === "credential_stuffing" && rng.chance(6_000);
  b.addTransaction(
    [...path, "txn"],
    {
      customerId: victim.customerId,
      cardId: victimCards[0] as string,
      merchantId: merchant.merchantId,
      sessionId: session.sessionId,
      atMs,
      amountMinor: rng.lognormalInt(merchant.avgTicketMinor * 1.4, 0.6, 5_000),
      status: stepUpFails ? "declined" : "captured",
      declineReason: stepUpFails ? "authentication_failed" : null,
      avsResult: rng.weighted([
        ["pass", 42],
        ["unavailable", 33],
        ["fail", 25],
      ]),
      cvvResult: "pass",
      threeDsResult: stepUpFails
        ? "fail"
        : rng.weighted([
            ["unavailable", 60],
            ["pass", 40],
          ]),
      shippingCity: SHIPPED_CATEGORIES.has(merchant.category) ? attackerCity.name : null,
    },
    { isFraud: !stepUpFails, family: ctx.family, variant: ctx.variant, scenarioId: ctx.scenarioId },
  );
}

/**
 * One operator, many mules. `shared_infrastructure` links accounts through a shared
 * device and IP — findable in the entity graph. `timing_only` gives every mule its own
 * device, IP, city and card; the only tie is coordinated bursts against the same
 * merchant for near-identical amounts, so a graph-reliant detector finds nothing.
 */
function abuseRing(
  b: WorldBuilder,
  ctx: FraudContext,
  n: number,
  variant: "shared_infrastructure" | "timing_only",
): void {
  const path = ["fraud", ctx.variant, n] as const;
  const rng = b.stream(...path);
  // A disciplined operator runs a smaller cluster and lets it age, which looks far more
  // like a household than a farm of freshly minted accounts.
  const size = rng.weighted([
    [2, 30],
    [4, 45],
    [6, 25],
  ]);
  const activeFrom = rng.int(3, Math.max(4, b.spec.days - 10));
  // Rings farm accounts well ahead of use. The coordination signal is that a ring's
  // accounts are created within hours of *each other*; placing that cluster anywhere in
  // the past keeps the signal without making account age a proxy for the label.
  const clusterAgeDays = rng.weighted([
    [rng.int(2, 40), 20],
    [rng.int(40, 220), 25],
    [rng.int(220, 560), 30],
    [rng.int(560, 950), 25],
  ]);
  const creationBase = b.spec.startAtMs + (activeFrom - clusterAgeDays) * DAY_MS;
  const merchants = liquidMerchants(b);
  const targetMerchant = rng.pick(merchants);

  const sharedDevice =
    variant === "shared_infrastructure"
      ? b.addDevice([...path, "shared-device"], rng, creationBase, {
          automationSignals: rng.chance(2_500),
        })
      : null;
  const sharedCity = b.pickCity(rng);
  const sharedIp =
    variant === "shared_infrastructure" ? b.homeIp([...path, "shared-ip"], rng, sharedCity) : null;

  const burstDays = rng
    .shuffle(Array.from({ length: b.spec.days - activeFrom }, (_, d) => d + activeFrom))
    .slice(0, rng.int(3, 6));
  const baseAmount = rng.lognormalInt(targetMerchant.avgTicketMinor, 0.35, 2_000);

  for (let m = 0; m < size; m += 1) {
    const mulePath = [...path, "mule", m] as const;
    const muleRng = b.stream(...mulePath);
    const city = variant === "shared_infrastructure" ? sharedCity : b.pickCity(muleRng, CITIES);
    const customerId = b.addCustomer(mulePath, {
      signupAtMs: creationBase + m * muleRng.int(10, 120) * MINUTE_MS,
      homeCountry: "IN",
      homeCity: city.name,
      emailDomain: b.pickEmailDomain(muleRng),
      kycLevel: muleRng.weighted([
        [0, 30],
        [1, 40],
        [2, 30],
      ]),
    }).customerId;
    b.labelEntity("customer", customerId, "mule", ctx.scenarioId);

    const device =
      sharedDevice ??
      b.addDevice(
        [...mulePath, "device"],
        muleRng,
        creationBase + muleRng.int(0, Math.max(0, clusterAgeDays - 1)) * DAY_MS,
      );
    const ip = sharedIp ?? b.homeIp([...mulePath, "ip"], muleRng, city);
    const card = b.addCard(
      [...mulePath, "card"],
      muleRng,
      customerId,
      creationBase + muleRng.int(0, Math.max(0, clusterAgeDays - 1)) * DAY_MS,
    );

    for (const [i, day] of burstDays.entries()) {
      // The coordination signal is that mules act inside the same narrow window, not
      // that the window sits at an unusual hour: the hour itself comes from the same
      // curve every legitimate customer uses.
      const windowStart = b.sampleDayTime(
        b.stream(...path, "window", day),
        b.spec.startAtMs + day * DAY_MS,
      );
      const atMs = windowStart + muleRng.int(0, 18) * MINUTE_MS;
      const session = b.addSession([...mulePath, "session", i], {
        customerId,
        deviceId: device.deviceId,
        ipId: ip.ipId,
        startedAtMs: atMs - muleRng.int(2, 14) * MINUTE_MS,
        endedAtMs: atMs + muleRng.int(1, 9) * MINUTE_MS,
        channel: "web",
      });
      b.addTransaction(
        [...mulePath, "txn", i],
        {
          customerId,
          cardId: card.cardId,
          merchantId: targetMerchant.merchantId,
          sessionId: session.sessionId,
          atMs,
          amountMinor: baseAmount + muleRng.int(-3, 3) * (baseAmount / 100),
          status: "captured",
          declineReason: null,
          avsResult: muleRng.weighted([
            ["pass", 55],
            ["unavailable", 45],
          ]),
          cvvResult: "pass",
          threeDsResult: "not_requested",
          shippingCity: SHIPPED_CATEGORIES.has(targetMerchant.category) ? city.name : null,
        },
        { isFraud: true, family: ctx.family, variant: ctx.variant, scenarioId: ctx.scenarioId },
      );
    }
  }
}

/**
 * A genuine customer disputes a genuine purchase. Nothing at authorisation time
 * distinguishes it — the label attaches to an ordinary transaction, and the dispute
 * lands weeks later. Included precisely because a system claiming to catch this
 * pre-authorisation would be lying.
 */
function friendlyFraud(
  b: WorldBuilder,
  legit: LegitimatePopulation,
  ctx: FraudContext,
  n: number,
  variant: "buyers_remorse" | "family_member",
): void {
  const path = ["fraud", ctx.variant, n] as const;
  const rng = b.stream(...path);
  const pool = legit.persons;
  if (pool.length === 0) return;
  const buyer = pool[rng.int(0, pool.length - 1)] as Person;

  const atMs = b.sampleDayTime(rng, b.spec.startAtMs + rng.int(2, b.spec.days - 30) * DAY_MS);
  const usableCards = b.cardsAvailableAt(buyer.cardIds, atMs);
  if (usableCards.length === 0) return;
  const merchant = rng.pick(b.merchantsIn(["electronics", "fashion", "gaming", "travel"]));
  const session = b.addSession([...path, "session"], {
    customerId: buyer.customerId,
    deviceId: rng.pick(buyer.deviceIds),
    ipId: buyer.homeIpId,
    startedAtMs: atMs - 6 * MINUTE_MS,
    endedAtMs: atMs + 4 * MINUTE_MS,
    channel: buyer.channel,
  });

  const amount = rng.lognormalInt(merchant.avgTicketMinor, 0.55, 3_000);
  const txn = b.addTransaction(
    [...path, "txn"],
    {
      customerId: buyer.customerId,
      cardId: rng.pick(usableCards),
      merchantId: merchant.merchantId,
      sessionId: session.sessionId,
      atMs,
      amountMinor: amount,
      status: "captured",
      declineReason: null,
      threeDsResult: amount >= 400_000 ? "pass" : "not_requested",
      shippingCity: SHIPPED_CATEGORIES.has(merchant.category) ? buyer.homeCity.name : null,
    },
    { isFraud: true, family: ctx.family, variant: ctx.variant, scenarioId: ctx.scenarioId },
  );

  b.addDispute([...path, "dispute"], {
    txnId: txn.txnId,
    openedAtMs: atMs + rng.int(20, 75) * DAY_MS,
    category: variant === "buyers_remorse" ? "not_as_described" : "unauthorised",
    outcome: rng.weighted([
      ["won", 40],
      ["lost", 35],
      ["pending", 25],
    ]),
  });
}
