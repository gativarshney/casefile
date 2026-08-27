import { CITIES } from "../../reference/geography.js";
import type { FraudFamily, FraudVariant } from "../labels.js";
import type { Merchant } from "../schema.js";
import type { WorldBuilder } from "./builder.js";
import { HIGH_LIQUIDITY } from "./catalog.js";
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
  const startMs = b.spec.startAtMs + rng.int(2, b.spec.days - 12) * DAY_MS;

  const customerId = b.addCustomer(path, {
    signupAtMs: startMs - rng.int(1, 6) * HOUR_MS,
    homeCountry: "IN",
    homeCity: city.name,
    emailDomain: b.pickEmailDomain(rng),
    kycLevel: 0,
  }).customerId;
  b.labelEntity("customer", customerId, "fraudster", ctx.scenarioId);

  const burstDevice =
    variant === "burst"
      ? b.addDevice([...path, "device"], rng, startMs, { automationSignals: rng.chance(6_000) })
      : null;
  const burstIp = variant === "burst" ? b.homeIp([...path, "ip"], rng, city) : null;

  const successIndex = attempts - rng.int(1, 3);
  for (let a = 0; a < attempts; a += 1) {
    const attemptRng = b.stream(...path, "attempt", a);
    const atMs =
      variant === "burst"
        ? startMs + a * attemptRng.int(20, 90) * 1_000
        : startMs + Math.floor(a / 5) * DAY_MS + (a % 5) * attemptRng.int(2, 6) * HOUR_MS;

    const device =
      burstDevice ??
      b.addDevice([...path, "device", a], attemptRng, atMs, {
        automationSignals: attemptRng.chance(3_000),
      });
    const ip = burstIp ?? b.homeIp([...path, "ip", a], attemptRng, b.pickCity(attemptRng));

    const session = b.addSession([...path, "session", a], {
      customerId,
      deviceId: device.deviceId,
      ipId: ip.ipId,
      startedAtMs: atMs - MINUTE_MS,
      endedAtMs: atMs + MINUTE_MS,
      channel: "web",
    });

    const card = b.addCard([...path, "card", a], attemptRng, customerId, atMs, {
      funding: "credit",
      issuerCountry: attemptRng.chance(2_500) ? attemptRng.pick(["US", "GB", "AE"]) : "IN",
    });

    const succeeded = a >= successIndex;
    const merchant = attemptRng.pick(merchants);
    b.addTransaction(
      [...path, "txn", a],
      {
        customerId,
        cardId: card.cardId,
        merchantId: merchant.merchantId,
        sessionId: session.sessionId,
        atMs,
        amountMinor: succeeded ? attemptRng.int(1_500, 6_000) * 100 : attemptRng.int(1, 6) * 100,
        status: succeeded ? "captured" : "declined",
        declineReason: succeeded
          ? null
          : attemptRng.weighted([
              ["invalid_card", 45],
              ["do_not_honour", 35],
              ["suspected_fraud", 12],
              ["expired_card", 8],
            ]),
        avsResult: succeeded ? "unavailable" : "fail",
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
  b.labelEntity("customer", victim.customerId, "victim", ctx.scenarioId);

  const atMs = b.sampleDayTime(rng, b.spec.startAtMs + rng.int(5, b.spec.days - 3) * DAY_MS);
  const attackerCity = b.pickCity(rng, CITIES);
  const device = b.addDevice([...path, "device"], rng, atMs - HOUR_MS, {
    automationSignals: rng.chance(2_000),
  });
  const ip = b.homeIp([...path, "ip"], rng, attackerCity);

  const session = b.addSession([...path, "session"], {
    customerId: victim.customerId,
    deviceId: device.deviceId,
    ipId: ip.ipId,
    startedAtMs: atMs - 40 * MINUTE_MS,
    endedAtMs: atMs + 20 * MINUTE_MS,
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

  const changes = rng
    .shuffle(["email", "phone", "shipping_address"] as const)
    .slice(0, rng.int(1, 2));
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
      cardId: victim.cardIds[0] as string,
      merchantId: merchant.merchantId,
      sessionId: session.sessionId,
      atMs,
      amountMinor: rng.int(4_500, 18_000) * 100,
      status: stepUpFails ? "declined" : "captured",
      declineReason: stepUpFails ? "authentication_failed" : null,
      avsResult: rng.weighted([
        ["unavailable", 55],
        ["fail", 30],
        ["pass", 15],
      ]),
      cvvResult: "pass",
      threeDsResult: stepUpFails
        ? "fail"
        : rng.weighted([
            ["unavailable", 60],
            ["pass", 40],
          ]),
      shippingCity: attackerCity.name,
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
  const size = rng.int(4, 9);
  const creationBase = b.spec.startAtMs + rng.int(3, b.spec.days - 10) * DAY_MS;
  const merchants = liquidMerchants(b);
  const targetMerchant = rng.pick(merchants);

  const sharedDevice =
    variant === "shared_infrastructure"
      ? b.addDevice([...path, "shared-device"], rng, creationBase, {
          automationSignals: rng.chance(4_000),
        })
      : null;
  const sharedCity = b.pickCity(rng);
  const sharedIp =
    variant === "shared_infrastructure" ? b.homeIp([...path, "shared-ip"], rng, sharedCity) : null;

  const burstDays = rng
    .shuffle(Array.from({ length: b.spec.days }, (_, d) => d))
    .slice(0, rng.int(2, 4));
  const baseAmount = rng.int(2_000, 8_000) * 100;

  for (let m = 0; m < size; m += 1) {
    const mulePath = [...path, "mule", m] as const;
    const muleRng = b.stream(...mulePath);
    const city = variant === "shared_infrastructure" ? sharedCity : b.pickCity(muleRng, CITIES);
    const customerId = b.addCustomer(mulePath, {
      signupAtMs: creationBase + m * muleRng.int(10, 120) * MINUTE_MS,
      homeCountry: "IN",
      homeCity: city.name,
      emailDomain: b.pickEmailDomain(muleRng),
      kycLevel: muleRng.int(0, 1),
    }).customerId;
    b.labelEntity("customer", customerId, "mule", ctx.scenarioId);

    const device = sharedDevice ?? b.addDevice([...mulePath, "device"], muleRng, creationBase);
    const ip = sharedIp ?? b.homeIp([...mulePath, "ip"], muleRng, city);
    const card = b.addCard([...mulePath, "card"], muleRng, customerId, creationBase);

    for (const [i, day] of burstDays.entries()) {
      const windowStart = b.spec.startAtMs + day * DAY_MS + 20 * HOUR_MS;
      const atMs = windowStart + muleRng.int(0, 18) * MINUTE_MS;
      const session = b.addSession([...mulePath, "session", i], {
        customerId,
        deviceId: device.deviceId,
        ipId: ip.ipId,
        startedAtMs: atMs - MINUTE_MS,
        endedAtMs: atMs + 3 * MINUTE_MS,
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
          amountMinor: baseAmount + muleRng.int(-200, 200) * 100,
          status: "captured",
          declineReason: null,
          avsResult: muleRng.weighted([
            ["pass", 55],
            ["unavailable", 45],
          ]),
          cvvResult: "pass",
          threeDsResult: "not_requested",
          shippingCity: city.name,
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
  const merchant = rng.pick(b.merchantsIn(["electronics", "fashion", "gaming", "travel"]));
  const session = b.addSession([...path, "session"], {
    customerId: buyer.customerId,
    deviceId: rng.pick(buyer.deviceIds),
    ipId: buyer.homeIpId,
    startedAtMs: atMs - 6 * MINUTE_MS,
    endedAtMs: atMs + 4 * MINUTE_MS,
    channel: buyer.channel,
  });

  const amount = rng.lognormalInt(merchant.avgTicketMinor * 1.2, 0.5, 5_000);
  const txn = b.addTransaction(
    [...path, "txn"],
    {
      customerId: buyer.customerId,
      cardId: rng.pick(buyer.cardIds),
      merchantId: merchant.merchantId,
      sessionId: session.sessionId,
      atMs,
      amountMinor: amount,
      status: "captured",
      declineReason: null,
      threeDsResult: amount >= 400_000 ? "pass" : "not_requested",
      shippingCity: buyer.homeCity.name,
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
