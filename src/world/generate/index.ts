import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENTITY_LABELS, TRANSACTION_LABELS } from "../labels.js";
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
  TRANSACTIONS,
} from "../schema.js";
import { type DatasetManifest, WorldStore } from "../store.js";
import { WorldBuilder } from "./builder.js";
import { enabledVariants, specDigest, type WorldSpec } from "./config.js";
import { buildFraud } from "./fraud.js";
import { buildLegitimatePopulation } from "./legit.js";

export interface GenerateOptions {
  readonly spec: WorldSpec;
  readonly outputDirectory: string;
}

export interface GenerateResult {
  readonly worldPath: string;
  readonly labelsPath: string;
  readonly manifestPath: string;
  readonly manifest: DatasetManifest;
  readonly counts: Record<string, number>;
}

export const WORLD_DB = "world.db";
export const LABELS_DB = "labels.db";
export const MANIFEST_FILE = "dataset_manifest.json";

export function generateWorld(options: GenerateOptions): GenerateResult {
  const { spec, outputDirectory } = options;
  const builder = new WorldBuilder(spec);
  const legit = buildLegitimatePopulation(builder);
  buildFraud(builder, legit);
  builder.applyBackgroundDisputes();

  const worldPath = join(outputDirectory, WORLD_DB);
  const labelsPath = join(outputDirectory, LABELS_DB);

  const world = new WorldStore(worldPath);
  world.insert(CUSTOMERS, [...builder.customers.values()]);
  world.insert(MERCHANTS, [...builder.merchants.values()]);
  world.insert(CARDS, [...builder.cards.values()]);
  world.insert(DEVICES, [...builder.devices.values()]);
  world.insert(IP_ADDRESSES, [...builder.ips.values()]);
  world.insert(SESSIONS, [...builder.sessions.values()]);
  world.insert(AUTH_EVENTS, [...builder.authEvents.values()]);
  world.insert(PROFILE_CHANGES, [...builder.profileChanges.values()]);
  world.insert(TRANSACTIONS, [...builder.transactions.values()]);
  world.insert(DISPUTES, [...builder.disputes.values()]);

  const fraudTxns = [...builder.txnLabels.values()].filter((label) => label.isFraud).length;
  const manifest = world.manifest({
    generator: "world-v1",
    spec: spec.name,
    seed: spec.seed,
    specDigest: specDigest(spec),
    enabledVariants: enabledVariants(spec),
  });
  world.close();

  const labels = new WorldStore(labelsPath, [TRANSACTION_LABELS, ENTITY_LABELS]);
  labels.insert(TRANSACTION_LABELS, [...builder.txnLabels.values()]);
  labels.insert(ENTITY_LABELS, [...builder.entityLabels.values()]);
  labels.close();

  const manifestPath = join(outputDirectory, MANIFEST_FILE);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    worldPath,
    labelsPath,
    manifestPath,
    manifest,
    counts: {
      customers: builder.customers.size,
      merchants: builder.merchants.size,
      cards: builder.cards.size,
      devices: builder.devices.size,
      ipAddresses: builder.ips.size,
      sessions: builder.sessions.size,
      authEvents: builder.authEvents.size,
      profileChanges: builder.profileChanges.size,
      transactions: builder.transactions.size,
      disputes: builder.disputes.size,
      fraudTransactions: fraudTxns,
    },
  };
}

export type { WorldSpec } from "./config.js";
export { developmentSpec, heldoutSpec, qualitySpec, testSpec } from "./config.js";
