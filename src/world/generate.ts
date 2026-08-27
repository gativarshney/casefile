/**
 * A deliberately small world, sufficient to drive one case end to end.
 *
 * The realistic generator — full entity graph, four fraud families, hard negatives —
 * replaces this. What matters here is that the shape is right: fraud emerges from an
 * actor's behaviour rather than being stamped onto a record, and the same seed
 * reproduces the same world exactly.
 *
 * Nothing on the investigation path may import this module.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stream } from "./rng.js";
import {
  CARDS,
  type Card,
  CUSTOMERS,
  type Customer,
  MERCHANTS,
  type Merchant,
  TRANSACTIONS,
  type Transaction,
} from "./schema.js";
import { type DatasetManifest, WorldStore } from "./store.js";

/** 2025-01-06T00:00:00Z, a Monday. Fixed rather than read from the clock. */
export const EPOCH_MS = 1_736_121_600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface GenerateOptions {
  readonly seed: number;
  readonly outputDirectory: string;
  readonly legitimateCustomers?: number;
}

export interface GenerateResult {
  readonly worldPath: string;
  readonly manifestPath: string;
  readonly manifest: DatasetManifest;
  readonly counts: Record<string, number>;
}

const MERCHANT_TEMPLATES = [
  { name: "Bluepeak Electronics", mcc: "5732", category: "electronics", avgTicketMinor: 480_000 },
  { name: "Kettle & Crumb", mcc: "5814", category: "food_delivery", avgTicketMinor: 42_000 },
  { name: "Vault Gift Cards", mcc: "5947", category: "gift_cards", avgTicketMinor: 250_000 },
] as const;

const CITIES = ["Bengaluru", "Mumbai", "Delhi", "Hyderabad", "Pune"] as const;
const BINS = ["411111", "521234", "607412", "455610", "534891", "652188"] as const;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function buildMerchants(): Merchant[] {
  return MERCHANT_TEMPLATES.map((template, index) => ({
    merchantId: `mer_${pad(index, 4)}`,
    name: template.name,
    mcc: template.mcc,
    category: template.category,
    country: "IN",
    avgTicketMinor: template.avgTicketMinor,
    baselineDisputeRateBps: 30 + index * 15,
    onboardedAtMs: EPOCH_MS - 400 * DAY_MS,
  }));
}

interface Population {
  customers: Customer[];
  cards: Card[];
  transactions: Transaction[];
}

/** Ordinary customers: a handful of successful purchases on one long-held card. */
function buildLegitimate(seed: number, count: number, merchants: readonly Merchant[]): Population {
  const customers: Customer[] = [];
  const cards: Card[] = [];
  const transactions: Transaction[] = [];

  for (let index = 0; index < count; index += 1) {
    const customerId = `cust_${pad(index, 4)}`;
    const rng = stream(seed, "legit", customerId);
    const tenureDays = rng.int(120, 900);

    customers.push({
      customerId,
      signupAtMs: EPOCH_MS - tenureDays * DAY_MS,
      homeCountry: "IN",
      homeCity: rng.pick(CITIES),
      emailDomain: rng.pick(["example.com", "mail.example", "post.example"]),
      kycLevel: rng.int(1, 2),
    });

    const cardId = `card_${pad(index, 4)}`;
    cards.push({
      cardId,
      customerId,
      bin: rng.pick(BINS),
      last4: pad(rng.int(0, 9999), 4),
      brand: rng.pick(["visa", "mastercard", "rupay"]),
      funding: rng.pick(["credit", "debit"]),
      issuerCountry: "IN",
      addedAtMs: EPOCH_MS - (tenureDays - 5) * DAY_MS,
      replacesCardId: null,
    });

    const purchases = rng.int(4, 11);
    for (let n = 0; n < purchases; n += 1) {
      const merchant = rng.pick(merchants);
      transactions.push({
        txnId: `txn_l${pad(index, 4)}_${pad(n, 3)}`,
        customerId,
        cardId,
        merchantId: merchant.merchantId,
        sessionId: `ses_l${pad(index, 4)}_${pad(n, 3)}`,
        atMs: EPOCH_MS - rng.int(1, 60) * DAY_MS + rng.int(0, 20) * HOUR_MS,
        amountMinor: Math.max(
          5_000,
          Math.round((merchant.avgTicketMinor * rng.int(40, 190)) / 100 / 100) * 100,
        ),
        currency: "INR",
        status: "captured",
        declineReason: null,
        avsResult: "pass",
        cvvResult: "pass",
        threeDsResult: rng.chance(7_000) ? "pass" : "not_requested",
        shippingCity: null,
        description: `Order ${rng.int(1000, 9999)}`,
      });
    }
  }
  return { customers, cards, transactions };
}

/**
 * Card testing: an actor validating stolen numbers. Many BINs, small amounts, mostly
 * declined, compressed into minutes — then one larger capture once a number sticks.
 *
 * The signature emerges from the sequence of attempts, not from any single record.
 */
function buildCardTesting(seed: number, merchants: readonly Merchant[]): Population {
  const rng = stream(seed, "card_testing", "scenario_0");
  const customerId = "cust_9001";
  const startMs = EPOCH_MS - 3 * DAY_MS;
  const liquid = merchants.find((m) => m.category === "gift_cards") ?? (merchants[0] as Merchant);

  const customers: Customer[] = [
    {
      customerId,
      signupAtMs: startMs - 2 * HOUR_MS,
      homeCountry: "IN",
      homeCity: rng.pick(CITIES),
      emailDomain: "burner.example",
      kycLevel: 0,
    },
  ];

  const cards: Card[] = [];
  const transactions: Transaction[] = [];
  const attempts = 14;

  for (let n = 0; n < attempts; n += 1) {
    const cardId = `card_9${pad(n, 3)}`;
    cards.push({
      cardId,
      customerId,
      bin: BINS[n % BINS.length] as string,
      last4: pad(rng.int(0, 9999), 4),
      brand: rng.pick(["visa", "mastercard"]),
      funding: "credit",
      issuerCountry: rng.chance(3_000) ? "US" : "IN",
      addedAtMs: startMs + n * 45_000,
      replacesCardId: null,
    });

    const succeeded = n === attempts - 1;
    transactions.push({
      txnId: `txn_f0001_${pad(n, 3)}`,
      customerId,
      cardId,
      merchantId: liquid.merchantId,
      sessionId: "ses_f0001",
      atMs: startMs + n * 45_000,
      amountMinor: succeeded ? 292_500 : rng.int(1, 5) * 100,
      currency: "INR",
      status: succeeded ? "captured" : "declined",
      declineReason: succeeded ? null : rng.pick(["invalid_card", "do_not_honour"]),
      avsResult: succeeded ? "unavailable" : "fail",
      cvvResult: succeeded ? "pass" : "fail",
      threeDsResult: "not_requested",
      shippingCity: null,
      description: succeeded ? "Gift card 500" : "Verification",
    });
  }
  return { customers, cards, transactions };
}

export function generateWorld(options: GenerateOptions): GenerateResult {
  const { seed, outputDirectory, legitimateCustomers = 40 } = options;
  const worldPath = join(outputDirectory, "world.db");
  const manifestPath = join(outputDirectory, "dataset_manifest.json");

  const merchants = buildMerchants();
  const legit = buildLegitimate(seed, legitimateCustomers, merchants);
  const fraud = buildCardTesting(seed, merchants);

  const customers = [...legit.customers, ...fraud.customers];
  const cards = [...legit.cards, ...fraud.cards];
  const transactions = [...legit.transactions, ...fraud.transactions];

  const store = new WorldStore(worldPath);
  store.insert(CUSTOMERS, customers);
  store.insert(MERCHANTS, merchants);
  store.insert(CARDS, cards);
  store.insert(TRANSACTIONS, transactions);
  const manifest = store.manifest({ seed, generator: "slice-v1", legitimateCustomers });
  store.close();

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    worldPath,
    manifestPath,
    manifest,
    counts: {
      customers: customers.length,
      merchants: merchants.length,
      cards: cards.length,
      transactions: transactions.length,
    },
  };
}
