import { digest } from "../../canon/hash.js";
import type { FraudVariant } from "../labels.js";

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

/** 2025-01-06T00:00:00Z, a Monday. Fixed rather than read from the clock. */
export const EPOCH_MS = 1_736_121_600_000;

export interface ArchetypeCounts {
  readonly casual: number;
  readonly powerUser: number;
  readonly reseller: number;
  readonly traveller: number;
  readonly households: number;
  readonly campuses: number;
  readonly studentsPerCampus: readonly [number, number];
  readonly newCustomer: number;
  readonly subscriber: number;
}

export interface FraudCounts {
  readonly cardTestingBurst: number;
  readonly cardTestingSlowLow: number;
  readonly atoCredentialStuffing: number;
  readonly atoSessionHijack: number;
  readonly ringSharedInfrastructure: number;
  readonly ringTimingOnly: number;
  readonly friendlyBuyersRemorse: number;
  readonly friendlyFamilyMember: number;
}

export interface DecoyCounts {
  readonly vpnUsers: number;
  readonly cardReissues: number;
  readonly giftsToNewAddress: number;
  readonly firstPurchaseHighValue: number;
  readonly newDeviceOnHoliday: number;
}

export interface NoiseRates {
  readonly deviceFingerprintMissingBps: number;
  readonly ipGeolocationMissingBps: number;
  readonly avsUnavailableBps: number;
  readonly falseVpnFlagBps: number;
  readonly legitimateDeclineBps: number;
  readonly promptInjectionBps: number;
}

export interface WorldSpec {
  readonly name: string;
  readonly seed: number;
  /** Distinct per world, mixed into every id: entity overlap across worlds is impossible. */
  readonly idNamespace: string;
  readonly startAtMs: number;
  readonly days: number;
  readonly archetypes: ArchetypeCounts;
  readonly fraud: FraudCounts;
  readonly decoys: DecoyCounts;
  readonly noise: NoiseRates;
}

export function specEndMs(spec: WorldSpec): number {
  return spec.startAtMs + spec.days * DAY_MS;
}

export function specDigest(spec: WorldSpec): string {
  return digest(spec as unknown as Record<string, unknown>);
}

export function enabledVariants(spec: WorldSpec): FraudVariant[] {
  const variants: FraudVariant[] = [];
  if (spec.fraud.cardTestingBurst > 0) variants.push("burst");
  if (spec.fraud.cardTestingSlowLow > 0) variants.push("slow_low");
  if (spec.fraud.atoCredentialStuffing > 0) variants.push("credential_stuffing");
  if (spec.fraud.atoSessionHijack > 0) variants.push("session_hijack");
  if (spec.fraud.ringSharedInfrastructure > 0) variants.push("shared_infrastructure");
  if (spec.fraud.ringTimingOnly > 0) variants.push("timing_only");
  if (spec.fraud.friendlyBuyersRemorse > 0) variants.push("buyers_remorse");
  if (spec.fraud.friendlyFamilyMember > 0) variants.push("family_member");
  return variants;
}

const DEFAULT_NOISE: NoiseRates = {
  deviceFingerprintMissingBps: 800,
  ipGeolocationMissingBps: 1_200,
  avsUnavailableBps: 1_500,
  falseVpnFlagBps: 300,
  legitimateDeclineBps: 450,
  promptInjectionBps: 150,
};

/**
 * The world used to design probes, fit the scorer and choose thresholds. The two
 * novel variants are absent by construction: their counts are zero.
 */
export function developmentSpec(): WorldSpec {
  return {
    name: "development",
    seed: 20_250_106,
    idNamespace: "d",
    startAtMs: EPOCH_MS,
    days: 90,
    archetypes: {
      casual: 250,
      powerUser: 105,
      reseller: 55,
      traveller: 65,
      households: 30,
      campuses: 3,
      studentsPerCampus: [22, 32],
      newCustomer: 130,
      subscriber: 55,
    },
    fraud: {
      cardTestingBurst: 30,
      cardTestingSlowLow: 0,
      atoCredentialStuffing: 28,
      atoSessionHijack: 17,
      ringSharedInfrastructure: 20,
      ringTimingOnly: 0,
      friendlyBuyersRemorse: 40,
      friendlyFamilyMember: 20,
    },
    decoys: {
      vpnUsers: 22,
      cardReissues: 20,
      giftsToNewAddress: 24,
      firstPurchaseHighValue: 22,
      newDeviceOnHoliday: 16,
    },
    noise: DEFAULT_NOISE,
  };
}

/**
 * Generated only after the scorer and policy are frozen, and evaluated once. Differs
 * from development in seed, namespace, time window, mix, base rate — and in containing
 * the two attack mechanisms development never saw.
 */
export function heldoutSpec(): WorldSpec {
  return {
    name: "heldout",
    seed: 90_240_517,
    idNamespace: "h",
    startAtMs: EPOCH_MS + 97 * DAY_MS,
    days: 45,
    archetypes: {
      casual: 140,
      powerUser: 55,
      reseller: 30,
      traveller: 38,
      households: 17,
      campuses: 2,
      studentsPerCampus: [20, 30],
      newCustomer: 78,
      subscriber: 30,
    },
    fraud: {
      cardTestingBurst: 12,
      cardTestingSlowLow: 8,
      atoCredentialStuffing: 12,
      atoSessionHijack: 8,
      ringSharedInfrastructure: 10,
      ringTimingOnly: 7,
      friendlyBuyersRemorse: 22,
      friendlyFamilyMember: 12,
    },
    decoys: {
      vpnUsers: 12,
      cardReissues: 11,
      giftsToNewAddress: 13,
      firstPurchaseHighValue: 12,
      newDeviceOnHoliday: 9,
    },
    noise: DEFAULT_NOISE,
  };
}

/**
 * Large enough for distribution checks to be meaningful, small enough to generate
 * inside a test run. Quality thresholds are statistical and say nothing useful about a
 * fifty-customer world.
 */
export function qualitySpec(): WorldSpec {
  const dev = developmentSpec();
  return {
    ...dev,
    name: "quality",
    idNamespace: "q",
    days: 60,
    archetypes: {
      casual: 120,
      powerUser: 45,
      reseller: 24,
      traveller: 28,
      households: 12,
      campuses: 2,
      studentsPerCampus: [18, 26],
      newCustomer: 55,
      subscriber: 24,
    },
    fraud: {
      cardTestingBurst: 12,
      cardTestingSlowLow: 0,
      atoCredentialStuffing: 12,
      atoSessionHijack: 7,
      ringSharedInfrastructure: 8,
      ringTimingOnly: 0,
      friendlyBuyersRemorse: 16,
      friendlyFamilyMember: 8,
    },
    decoys: {
      vpnUsers: 10,
      cardReissues: 9,
      giftsToNewAddress: 10,
      firstPurchaseHighValue: 9,
      newDeviceOnHoliday: 7,
    },
  };
}

/** Small enough for fast unit tests while exercising every mechanism. */
export function testSpec(overrides: Partial<WorldSpec> = {}): WorldSpec {
  return {
    name: "test",
    seed: 7,
    idNamespace: "t",
    startAtMs: EPOCH_MS,
    days: 30,
    archetypes: {
      casual: 24,
      powerUser: 8,
      reseller: 5,
      traveller: 5,
      households: 3,
      campuses: 1,
      studentsPerCampus: [8, 10],
      newCustomer: 6,
      subscriber: 5,
    },
    fraud: {
      cardTestingBurst: 4,
      cardTestingSlowLow: 0,
      atoCredentialStuffing: 4,
      atoSessionHijack: 2,
      ringSharedInfrastructure: 2,
      ringTimingOnly: 0,
      friendlyBuyersRemorse: 5,
      friendlyFamilyMember: 3,
    },
    decoys: {
      vpnUsers: 3,
      cardReissues: 3,
      giftsToNewAddress: 3,
      firstPurchaseHighValue: 3,
      newDeviceOnHoliday: 2,
    },
    noise: DEFAULT_NOISE,
    ...overrides,
  };
}
