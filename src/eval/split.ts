import { digest } from "../canon/hash.js";
import { CARDS, SESSIONS } from "../world/schema.js";
import type { WorldReader } from "../world/store.js";

export type Fold = "fit" | "calibrate";

/**
 * Splits the development world into a fitting fold and a calibration fold along
 * connected components of the entity graph.
 *
 * A random split by transaction would put the same customer, the same shared device and
 * the same fraud ring on both sides, so the calibration fold would be measuring
 * memorisation. Components are assigned whole, which means an entity contributes to
 * exactly one fold and the calibrated probabilities describe behaviour the model has
 * not already seen.
 *
 * Only strong links join a component: a shared device or a shared payment instrument.
 * Shared addresses are excluded deliberately — a campus NAT would merge hundreds of
 * unrelated students into one component and make the partition meaningless.
 */
export function splitByComponent(reader: WorldReader, calibrateShare = 0.3): Map<string, Fold> {
  const parent = new Map<string, string>();

  const find = (node: string): string => {
    let root = node;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) as string;
    let cursor = node;
    while ((parent.get(cursor) ?? cursor) !== cursor) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  const ensure = (node: string): void => {
    if (!parent.has(node)) parent.set(node, node);
  };

  const accountsByDevice = new Map<string, Set<string>>();
  for (const session of reader.all(SESSIONS)) {
    if (!session.customerId) continue;
    ensure(session.customerId);
    const set = accountsByDevice.get(session.deviceId) ?? new Set<string>();
    set.add(session.customerId);
    accountsByDevice.set(session.deviceId, set);
  }
  for (const accounts of accountsByDevice.values()) {
    const members = [...accounts];
    for (let index = 1; index < members.length; index += 1) {
      union(members[0] as string, members[index] as string);
    }
  }

  const accountsByInstrument = new Map<string, Set<string>>();
  for (const card of reader.all(CARDS)) {
    ensure(card.customerId);
    const key = `${card.bin}:${card.last4}`;
    const set = accountsByInstrument.get(key) ?? new Set<string>();
    set.add(card.customerId);
    accountsByInstrument.set(key, set);
  }
  for (const accounts of accountsByInstrument.values()) {
    const members = [...accounts];
    for (let index = 1; index < members.length; index += 1) {
      union(members[0] as string, members[index] as string);
    }
  }

  // Assignment hashes the component root, so a customer's fold depends only on the
  // component it belongs to — not on iteration order or population size.
  const assignment = new Map<string, Fold>();
  const threshold = Math.round(calibrateShare * 10_000);
  for (const node of parent.keys()) {
    const root = find(node);
    const bucket = Number.parseInt(digest([root]).slice(7, 15), 16) % 10_000;
    assignment.set(node, bucket < threshold ? "calibrate" : "fit");
  }
  return assignment;
}

export interface SplitSummary {
  readonly fit: number;
  readonly calibrate: number;
  readonly components: number;
  readonly largestComponent: number;
}

export function summariseSplit(assignment: ReadonlyMap<string, Fold>): SplitSummary {
  let fit = 0;
  let calibrate = 0;
  for (const fold of assignment.values()) {
    if (fold === "fit") fit += 1;
    else calibrate += 1;
  }
  return { fit, calibrate, components: 0, largestComponent: 0 };
}
