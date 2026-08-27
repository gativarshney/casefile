import type { City } from "../../reference/geography.js";
import { CITIES } from "../../reference/geography.js";
import type { DecoyKind } from "../labels.js";
import type { RandomStream } from "../rng.js";
import type { Merchant, MerchantCategory } from "../schema.js";
import type { WorldBuilder } from "./builder.js";
import { UNIVERSITY_ASNS } from "./catalog.js";
import { DAY_MS, HOUR_MS, MINUTE_MS, type WorldSpec } from "./config.js";

export interface Person {
  readonly customerId: string;
  readonly archetype: string;
  readonly homeCity: City;
  readonly path: readonly (string | number)[];
  readonly cardIds: string[];
  readonly deviceIds: string[];
  readonly homeIpId: string;
  readonly mobileIpId: string;
  readonly channel: "web" | "mobile_app";
  readonly signupAtMs: number;
  readonly kycLevel: number;
}

export interface Household {
  readonly members: readonly Person[];
  readonly sharedDeviceId: string;
}

export interface LegitimatePopulation {
  readonly persons: readonly Person[];
  readonly households: readonly Household[];
  /** Established accounts with real history — the pool takeover scenarios draw victims from. */
  readonly victimPool: readonly Person[];
}

type CategoryMix = readonly (readonly [MerchantCategory, number])[];

const THREE_DS_THRESHOLD_MINOR = 400_000;

const SHIPPED_CATEGORIES: ReadonlySet<string> = new Set([
  "electronics",
  "fashion",
  "grocery",
  "food_delivery",
]);

const CASUAL_MIX: CategoryMix = [
  ["grocery", 25],
  ["food_delivery", 25],
  ["fashion", 15],
  ["utilities", 15],
  ["electronics", 8],
  ["subscription", 5],
  ["travel", 4],
  ["gaming", 3],
];

const POWER_MIX: CategoryMix = [
  ["food_delivery", 20],
  ["grocery", 18],
  ["electronics", 15],
  ["fashion", 15],
  ["travel", 10],
  ["gaming", 8],
  ["utilities", 8],
  ["subscription", 6],
];

const RESELLER_MIX: CategoryMix = [
  ["gift_cards", 35],
  ["electronics", 25],
  ["wallet_topup", 20],
  ["gaming", 10],
  ["fashion", 5],
  ["food_delivery", 5],
];

const STUDENT_MIX: CategoryMix = [
  ["food_delivery", 30],
  ["gaming", 20],
  ["subscription", 15],
  ["fashion", 15],
  ["grocery", 10],
  ["wallet_topup", 10],
];

const TRAVELLER_MIX: CategoryMix = [
  ["travel", 30],
  ["food_delivery", 20],
  ["fashion", 15],
  ["grocery", 10],
  ["electronics", 10],
  ["utilities", 8],
  ["subscription", 7],
];

interface PersonOptions {
  readonly tenureDays?: readonly [number, number];
  readonly cards?: readonly [number, number];
  readonly devices?: readonly [number, number];
  readonly kyc?: readonly [number, number];
  readonly city?: City;
}

export function setupPerson(
  b: WorldBuilder,
  archetype: string,
  index: number,
  options: PersonOptions = {},
): Person {
  const path = ["legit", archetype, index] as const;
  const rng = b.stream(...path, "setup");
  const homeCity = options.city ?? b.pickCity(rng);
  const [tenureMin, tenureMax] = options.tenureDays ?? [120, 900];
  const tenureDays = rng.int(tenureMin, tenureMax);
  const signupAtMs = b.spec.startAtMs - tenureDays * DAY_MS;
  const [kycMin, kycMax] = options.kyc ?? [1, 2];

  const customer = b.addCustomer(path, {
    signupAtMs,
    homeCountry: homeCity.country,
    homeCity: homeCity.name,
    emailDomain: b.pickEmailDomain(rng),
    kycLevel: rng.int(kycMin, kycMax),
  });

  const [cardMin, cardMax] = options.cards ?? [1, 2];
  const cardIds: string[] = [];
  for (let c = 0; c < rng.int(cardMin, cardMax); c += 1) {
    cardIds.push(
      b.addCard(
        [...path, "card", c],
        rng,
        customer.customerId,
        signupAtMs + rng.int(1, 40) * DAY_MS,
      ).cardId,
    );
  }

  const [devMin, devMax] = options.devices ?? [1, 2];
  const deviceIds: string[] = [];
  for (let d = 0; d < rng.int(devMin, devMax); d += 1) {
    deviceIds.push(
      b.addDevice([...path, "device", d], rng, signupAtMs + rng.int(0, 30) * DAY_MS).deviceId,
    );
  }

  const homeIpId = b.homeIp([...path, "ip", "home"], rng, homeCity).ipId;
  const mobileIpId = b.mobileIp([...path, "ip", "mobile"], rng, homeCity).ipId;

  maybeBackgroundProfileChange(b, path, rng, customer.customerId, deviceIds, homeIpId);

  return {
    customerId: customer.customerId,
    archetype,
    homeCity,
    path,
    cardIds,
    deviceIds,
    homeIpId,
    mobileIpId,
    channel: rng.chance(5_500) ? "mobile_app" : "web",
    signupAtMs,
    kycLevel: customer.kycLevel,
  };
}

/** Legitimate contact-detail churn exists too; without it, any profile change would be a fraud label. */
function maybeBackgroundProfileChange(
  b: WorldBuilder,
  path: readonly (string | number)[],
  rng: RandomStream,
  customerId: string,
  deviceIds: readonly string[],
  homeIpId: string,
): void {
  if (!rng.chance(2_500)) return;
  const day = rng.int(0, b.spec.days - 1);
  const atMs = b.sampleDayTime(rng, b.spec.startAtMs + day * DAY_MS);
  const session = b.addSession([...path, "profile-session"], {
    customerId,
    deviceId: rng.pick(deviceIds),
    ipId: homeIpId,
    startedAtMs: atMs - 5 * MINUTE_MS,
    endedAtMs: atMs + 5 * MINUTE_MS,
    channel: "web",
  });
  b.addProfileChange([...path, "profile-change"], {
    customerId,
    sessionId: session.sessionId,
    field: rng.weighted([
      ["phone", 35],
      ["email", 30],
      ["shipping_address", 25],
      ["password", 10],
    ]),
    atMs,
  });
}

export interface PurchaseEventOverrides {
  readonly ipId?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly shippingCity?: string | null | undefined;
  readonly amountFactor?: number | undefined;
  readonly merchant?: Merchant | undefined;
  readonly decoyKind?: DecoyKind | undefined;
}

interface LifeOptions {
  readonly purchases: number;
  readonly mix: CategoryMix;
  readonly factor: readonly [number, number];
  readonly activeFromDay?: number | undefined;
  readonly decoyKind?: DecoyKind | undefined;
  readonly overrideAt?:
    | ((eventRng: RandomStream, atMs: number, eventIndex: number) => PurchaseEventOverrides)
    | undefined;
}

export function runPurchaseLife(b: WorldBuilder, person: Person, life: LifeOptions): void {
  const fromDay = life.activeFromDay ?? 0;
  for (let event = 0; event < life.purchases; event += 1) {
    const rng = b.stream(...person.path, "event", event);
    const day = rng.int(fromDay, b.spec.days - 1);
    const atMs = b.sampleDayTime(rng, b.spec.startAtMs + day * DAY_MS);
    const overrides = life.overrideAt?.(rng, atMs, event) ?? {};
    emitPurchase(b, person, [...person.path, "event", event], rng, atMs, life, overrides);
  }
}

export function emitPurchase(
  b: WorldBuilder,
  person: Person,
  path: readonly (string | number)[],
  rng: RandomStream,
  atMs: number,
  life: Pick<LifeOptions, "mix" | "factor" | "decoyKind">,
  overrides: PurchaseEventOverrides = {},
): void {
  const merchant = overrides.merchant ?? pickMerchant(b, rng, life.mix);
  const deviceId = overrides.deviceId ?? rng.pick(person.deviceIds);
  const ipId = overrides.ipId ?? (rng.chance(7_000) ? person.homeIpId : person.mobileIpId);

  const session = b.addSession([...path, "session"], {
    customerId: person.customerId,
    deviceId,
    ipId,
    startedAtMs: atMs - rng.int(2, 15) * MINUTE_MS,
    endedAtMs: atMs + rng.int(1, 10) * MINUTE_MS,
    channel: person.channel,
  });

  if (rng.chance(6_500)) {
    b.addAuthEvent([...path, "login"], {
      sessionId: session.sessionId,
      customerId: person.customerId,
      kind: "login",
      outcome: "success",
      atMs: session.startedAtMs,
    });
  }

  const txnCount = rng.chance(2_500) ? 2 : 1;
  for (let t = 0; t < txnCount; t += 1) {
    const [factorMin, factorMax] = life.factor;
    const factor = overrides.amountFactor ?? factorMin + rng.next() * (factorMax - factorMin);
    const amountMinor = rng.lognormalInt(merchant.avgTicketMinor * factor, 0.55, 2_000);
    emitTransaction(b, person, [...path, "txn", t], rng, {
      session,
      merchant,
      cardId: rng.pick(person.cardIds),
      atMs: atMs + t * rng.int(1, 4) * MINUTE_MS,
      amountMinor,
      shippingCity:
        overrides.shippingCity !== undefined
          ? overrides.shippingCity
          : SHIPPED_CATEGORIES.has(merchant.category)
            ? person.homeCity.name
            : null,
      decoyKind: overrides.decoyKind ?? life.decoyKind,
    });
  }
}

function emitTransaction(
  b: WorldBuilder,
  person: Person,
  path: readonly (string | number)[],
  rng: RandomStream,
  input: {
    session: { sessionId: string; startedAtMs: number };
    merchant: Merchant;
    cardId: string;
    atMs: number;
    amountMinor: number;
    shippingCity: string | null;
    decoyKind?: DecoyKind | undefined;
  },
): void {
  let status: "captured" | "declined" = "captured";
  let declineReason:
    | "insufficient_funds"
    | "do_not_honour"
    | "expired_card"
    | "authentication_failed"
    | null = null;
  let threeDs: "pass" | "fail" | "unavailable" | "not_requested" = "not_requested";

  if (rng.chance(b.spec.noise.legitimateDeclineBps)) {
    status = "declined";
    declineReason = rng.weighted([
      ["insufficient_funds", 72],
      ["do_not_honour", 18],
      ["expired_card", 10],
    ]);
  } else if (input.amountMinor >= THREE_DS_THRESHOLD_MINOR) {
    threeDs = rng.weighted([
      ["pass", 89],
      ["unavailable", 6],
      ["fail", 5],
    ]);
    if (threeDs === "fail") {
      status = "declined";
      declineReason = "authentication_failed";
    }
    if (threeDs !== "unavailable") {
      b.addAuthEvent([...path, "3ds"], {
        sessionId: input.session.sessionId,
        customerId: person.customerId,
        kind: "three_ds_challenge",
        outcome: threeDs === "pass" ? "success" : "failure",
        atMs: input.atMs - MINUTE_MS,
      });
    }
  }

  b.addTransaction(
    path,
    {
      customerId: person.customerId,
      cardId: input.cardId,
      merchantId: input.merchant.merchantId,
      sessionId: input.session.sessionId,
      atMs: input.atMs,
      amountMinor: input.amountMinor,
      status,
      declineReason,
      threeDsResult: threeDs,
      shippingCity: input.shippingCity,
    },
    { isFraud: false, archetype: person.archetype, decoyKind: input.decoyKind },
  );
}

function pickMerchant(b: WorldBuilder, rng: RandomStream, mix: CategoryMix): Merchant {
  const category = rng.weighted(mix);
  const pool = b.merchantsIn([category]);
  return rng.pick(pool);
}

function scaled(spec: WorldSpec, range: readonly [number, number], rng: RandomStream): number {
  const scale = spec.days / 90;
  return Math.max(1, Math.round(rng.int(range[0], range[1]) * scale));
}

function buildCasualLike(
  b: WorldBuilder,
  archetype: string,
  count: number,
  decoyKind: DecoyKind | undefined,
  personOptions: PersonOptions,
  customise?: (person: Person, rng: RandomStream, index: number) => LifeOptions | null,
): Person[] {
  const persons: Person[] = [];
  for (let index = 0; index < count; index += 1) {
    const person = setupPerson(b, archetype, index, personOptions);
    const rng = b.stream(...person.path, "life");
    const life = customise?.(person, rng, index) ?? {
      purchases: scaled(b.spec, [6, 16], rng),
      mix: CASUAL_MIX,
      factor: [0.8, 1.3] as const,
      decoyKind,
    };
    runPurchaseLife(b, person, life);
    persons.push(person);
  }
  return persons;
}

export function buildLegitimatePopulation(b: WorldBuilder): LegitimatePopulation {
  const spec = b.spec;
  const persons: Person[] = [];
  const victimPool: Person[] = [];

  const casuals = buildCasualLike(b, "casual", spec.archetypes.casual, undefined, {});
  persons.push(...casuals);
  victimPool.push(...casuals);

  const powerUsers = buildCasualLike(
    b,
    "power_user",
    spec.archetypes.powerUser,
    undefined,
    { cards: [2, 3], devices: [2, 2], tenureDays: [200, 1000] },
    (_person, rng) => ({
      purchases: scaled(spec, [40, 80], rng),
      mix: POWER_MIX,
      factor: [0.9, 1.4],
    }),
  );
  persons.push(...powerUsers);
  victimPool.push(...powerUsers);

  persons.push(
    ...buildCasualLike(
      b,
      "reseller",
      spec.archetypes.reseller,
      "high_velocity_reseller",
      { cards: [3, 5], tenureDays: [250, 800] },
      (_person, rng) => ({
        purchases: scaled(spec, [55, 100], rng),
        mix: RESELLER_MIX,
        factor: [1.5, 3.0],
        decoyKind: "high_velocity_reseller",
      }),
    ),
  );

  persons.push(...buildTravellers(b));
  const households = buildHouseholds(b);
  persons.push(...households.flatMap((h) => h.members));
  persons.push(...buildStudents(b));
  persons.push(...buildNewCustomers(b));
  persons.push(...buildSubscribers(b));
  persons.push(...buildVpnUsers(b));
  persons.push(...buildCardReissues(b));
  persons.push(...buildGiftSenders(b));

  for (const person of persons) {
    b.labelEntity("customer", person.customerId, "legitimate", null);
  }

  return { persons, households, victimPool };
}

function buildTravellers(b: WorldBuilder): Person[] {
  const persons: Person[] = [];
  for (let index = 0; index < b.spec.archetypes.traveller; index += 1) {
    const person = setupPerson(b, "traveller", index, { tenureDays: [200, 900] });
    const rng = b.stream(...person.path, "life");
    const newDeviceDecoy = index < b.spec.decoys.newDeviceOnHoliday;

    interface Trip {
      fromDay: number;
      toDay: number;
      ipId: string;
      deviceId?: string;
      city: City;
    }
    const trips: Trip[] = [];
    const tripCount = rng.int(2, Math.max(2, Math.floor(b.spec.days / 25)));
    for (let t = 0; t < tripCount; t += 1) {
      const fromDay = rng.int(0, b.spec.days - 8);
      const city = b.pickCity(rng, CITIES);
      const trip: Trip = {
        fromDay,
        toDay: fromDay + rng.int(3, 8),
        city,
        ipId: b.homeIp([...person.path, "trip", t, "ip"], rng, city).ipId,
      };
      if (newDeviceDecoy && t === 0) {
        trip.deviceId = b.addDevice(
          [...person.path, "trip", t, "device"],
          rng,
          b.spec.startAtMs + fromDay * DAY_MS,
        ).deviceId;
      }
      trips.push(trip);
    }

    runPurchaseLife(b, person, {
      purchases: scaled(b.spec, [12, 26], rng),
      mix: TRAVELLER_MIX,
      factor: [0.9, 1.5],
      decoyKind: "travelling_customer",
      overrideAt: (eventRng, atMs) => {
        const day = Math.floor((atMs - b.spec.startAtMs) / DAY_MS);
        const trip = trips.find((candidate) => day >= candidate.fromDay && day <= candidate.toDay);
        if (!trip) return {};
        const overrides: PurchaseEventOverrides = { ipId: trip.ipId };
        if (trip.deviceId && eventRng.chance(8_000)) {
          return { ...overrides, deviceId: trip.deviceId, decoyKind: "new_device_on_holiday" };
        }
        return overrides;
      },
    });
    persons.push(person);
  }
  return persons;
}

function buildHouseholds(b: WorldBuilder): Household[] {
  const households: Household[] = [];
  for (let h = 0; h < b.spec.archetypes.households; h += 1) {
    const rng = b.stream("legit", "household", h);
    const city = b.pickCity(rng);
    const sharedDevice = b.addDevice(
      ["legit", "household", h, "shared-device"],
      rng,
      b.spec.startAtMs - rng.int(180, 700) * DAY_MS,
    );
    const sharedIp = b.homeIp(["legit", "household", h, "ip"], rng, city);

    const members: Person[] = [];
    const memberCount = rng.int(2, 4);
    for (let m = 0; m < memberCount; m += 1) {
      const person = setupPerson(b, "household", h * 10 + m, {
        city,
        devices: [1, 1],
        tenureDays: [180, 900],
      });
      const member: Person = {
        ...person,
        deviceIds: [sharedDevice.deviceId, ...person.deviceIds],
        homeIpId: sharedIp.ipId,
      };
      const lifeRng = b.stream(...member.path, "life");
      runPurchaseLife(b, member, {
        purchases: scaled(b.spec, [5, 14], lifeRng),
        mix: CASUAL_MIX,
        factor: [0.8, 1.3],
        decoyKind: "shared_household_device",
      });
      members.push(member);
    }
    households.push({ members, sharedDeviceId: sharedDevice.deviceId });
  }
  return households;
}

function buildStudents(b: WorldBuilder): Person[] {
  const persons: Person[] = [];
  const [minPer, maxPer] = b.spec.archetypes.studentsPerCampus;
  for (let campus = 0; campus < b.spec.archetypes.campuses; campus += 1) {
    const campusRng = b.stream("legit", "campus", campus);
    const city = b.pickCity(campusRng);
    const campusIp = b.addIp(
      ["legit", "campus", campus, "nat"],
      campusRng.pick(UNIVERSITY_ASNS),
      city,
    );
    const studentCount = campusRng.int(minPer, maxPer);
    for (let s = 0; s < studentCount; s += 1) {
      const person = setupPerson(b, "student", campus * 1_000 + s, {
        city,
        tenureDays: [60, 400],
        kyc: [0, 1],
        cards: [1, 1],
      });
      const rng = b.stream(...person.path, "life");
      runPurchaseLife(b, person, {
        purchases: scaled(b.spec, [4, 12], rng),
        mix: STUDENT_MIX,
        factor: [0.5, 0.9],
        decoyKind: "shared_campus_network",
        overrideAt: (eventRng) => (eventRng.chance(7_000) ? { ipId: campusIp.ipId } : {}),
      });
      persons.push(person);
    }
  }
  return persons;
}

function buildNewCustomers(b: WorldBuilder): Person[] {
  const persons: Person[] = [];
  for (let index = 0; index < b.spec.archetypes.newCustomer; index += 1) {
    const highValueDecoy = index < b.spec.decoys.firstPurchaseHighValue;
    const person = setupPerson(b, "new_customer", index, {
      tenureDays: [-1, -1],
      kyc: highValueDecoy ? [2, 2] : [0, 2],
      cards: [1, 1],
      devices: [1, 1],
    });
    const rng = b.stream(...person.path, "life");
    const signupDay = rng.int(0, Math.max(0, b.spec.days - 10));
    const patched: Person = { ...person, signupAtMs: b.spec.startAtMs + signupDay * DAY_MS };
    b.customers.set(person.customerId, {
      ...(b.customers.get(person.customerId) as NonNullable<ReturnType<typeof b.customers.get>>),
      signupAtMs: patched.signupAtMs,
    });

    if (highValueDecoy) {
      const atMs = b.sampleDayTime(rng, b.spec.startAtMs + (signupDay + rng.int(0, 2)) * DAY_MS);
      const merchant = rng.pick(b.merchantsIn(["electronics", "travel"]));
      emitPurchase(
        b,
        patched,
        [...patched.path, "first"],
        rng,
        atMs,
        { mix: CASUAL_MIX, factor: [3.0, 5.0] },
        { merchant, decoyKind: "first_purchase_high_value", amountFactor: rng.int(30, 50) / 10 },
      );
    }
    runPurchaseLife(b, patched, {
      purchases: rng.int(1, 4),
      mix: CASUAL_MIX,
      factor: [0.8, 1.3],
      activeFromDay: signupDay,
    });
    persons.push(patched);
  }
  return persons;
}

function buildSubscribers(b: WorldBuilder): Person[] {
  const persons: Person[] = [];
  for (let index = 0; index < b.spec.archetypes.subscriber; index += 1) {
    const person = setupPerson(b, "subscriber", index, { tenureDays: [200, 1000] });
    const rng = b.stream(...person.path, "life");
    const subscriptions = rng.int(2, 4);
    const merchants = b.merchantsIn(["subscription", "utilities"]);
    for (let s = 0; s < subscriptions; s += 1) {
      const merchant = rng.pick(merchants);
      const chargeDay = rng.int(0, 27);
      const chargeHour = rng.int(6, 22);
      for (let day = chargeDay; day < b.spec.days; day += 30) {
        const atMs =
          b.spec.startAtMs + day * DAY_MS + chargeHour * HOUR_MS + rng.int(0, 30) * MINUTE_MS;
        const session = b.addSession([...person.path, "sub", s, "cycle", day], {
          customerId: person.customerId,
          deviceId: person.deviceIds[0] as string,
          ipId: person.homeIpId,
          startedAtMs: atMs - MINUTE_MS,
          endedAtMs: atMs + MINUTE_MS,
          channel: "recurring",
        });
        b.addTransaction(
          [...person.path, "sub", s, "txn", day],
          {
            customerId: person.customerId,
            cardId: person.cardIds[0] as string,
            merchantId: merchant.merchantId,
            sessionId: session.sessionId,
            atMs,
            amountMinor: merchant.avgTicketMinor,
            status: "captured",
            declineReason: null,
            threeDsResult: "not_requested",
            shippingCity: null,
          },
          { isFraud: false, archetype: "subscriber" },
        );
      }
    }
    runPurchaseLife(b, person, {
      purchases: scaled(b.spec, [2, 6], rng),
      mix: CASUAL_MIX,
      factor: [0.8, 1.2],
    });
    persons.push(person);
  }
  return persons;
}

function buildVpnUsers(b: WorldBuilder): Person[] {
  return buildCasualLike(
    b,
    "vpn_user",
    b.spec.decoys.vpnUsers,
    "vpn_user",
    { tenureDays: [150, 800] },
    (person, rng) => {
      const vpnIp = b.datacenterIp([...person.path, "vpn-ip"], rng);
      return {
        purchases: scaled(b.spec, [8, 20], rng),
        mix: CASUAL_MIX,
        factor: [0.8, 1.3],
        decoyKind: "vpn_user",
        overrideAt: (eventRng) => (eventRng.chance(8_500) ? { ipId: vpnIp.ipId } : {}),
      };
    },
  );
}

function buildCardReissues(b: WorldBuilder): Person[] {
  const persons: Person[] = [];
  for (let index = 0; index < b.spec.decoys.cardReissues; index += 1) {
    const person = setupPerson(b, "card_reissue", index, { cards: [1, 1] });
    const rng = b.stream(...person.path, "life");
    const reissueDay = rng.int(Math.floor(b.spec.days * 0.3), Math.floor(b.spec.days * 0.7));
    const oldCardId = person.cardIds[0] as string;
    const oldCard = b.cards.get(oldCardId);
    const newCard = b.addCard(
      [...person.path, "reissued-card"],
      rng,
      person.customerId,
      b.spec.startAtMs + reissueDay * DAY_MS,
      { brand: oldCard?.brand, replacesCardId: oldCardId },
    );
    runPurchaseLife(b, person, {
      purchases: scaled(b.spec, [8, 18], rng),
      mix: CASUAL_MIX,
      factor: [0.8, 1.3],
      overrideAt: (eventRng, atMs) => {
        const afterReissue = atMs >= b.spec.startAtMs + reissueDay * DAY_MS;
        void eventRng;
        return afterReissue ? { decoyKind: "card_reissue" } : {};
      },
    });
    for (const txn of b.transactions.values()) {
      if (
        txn.customerId === person.customerId &&
        txn.atMs >= b.spec.startAtMs + reissueDay * DAY_MS &&
        txn.cardId === oldCardId
      ) {
        b.transactions.set(txn.txnId, { ...txn, cardId: newCard.cardId });
      }
    }
    persons.push(person);
  }
  return persons;
}

function buildGiftSenders(b: WorldBuilder): Person[] {
  return buildCasualLike(
    b,
    "gift_sender",
    b.spec.decoys.giftsToNewAddress,
    undefined,
    {},
    (person, rng) => {
      const giftEvent = rng.int(0, 5);
      const giftCity = b.pickCity(rng);
      return {
        purchases: scaled(b.spec, [6, 14], rng),
        mix: CASUAL_MIX,
        factor: [0.8, 1.4],
        overrideAt: (eventRng, _atMs, eventIndex) => {
          if (eventIndex !== giftEvent) return {};
          const merchant = eventRng.pick(b.merchantsIn(["electronics", "fashion"]));
          return {
            merchant,
            shippingCity: giftCity.name === person.homeCity.name ? "Mysuru" : giftCity.name,
            decoyKind: "gift_to_new_address",
            amountFactor: 1.6,
          };
        },
      };
    },
  );
}
