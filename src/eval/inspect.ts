import { LabelReader, TRANSACTION_LABELS } from "../world/labels.js";
import {
  CARDS,
  CUSTOMERS,
  DEVICES,
  DISPUTES,
  IP_ADDRESSES,
  MERCHANTS,
  PROFILE_CHANGES,
  SESSIONS,
  TRANSACTIONS,
} from "../world/schema.js";
import { WorldReader } from "../world/store.js";
import {
  categoricalDivergence,
  counted,
  divergenceUnderNull,
  median,
  quantile,
  separation,
} from "./stats.js";

export interface Check {
  readonly name: string;
  readonly value: string;
  readonly bound: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface Distribution {
  readonly name: string;
  readonly rows: readonly (readonly [string, string])[];
}

export interface InspectionReport {
  readonly counts: Record<string, number>;
  readonly distributions: readonly Distribution[];
  readonly singleFieldSeparation: readonly (readonly [string, number])[];
  readonly checks: readonly Check[];
  readonly passed: boolean;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Hardness criteria fixed in advance, on development data. If any single field can
 * separate the classes, the verifier can exploit a generator artifact instead of
 * combining evidence, and the evaluation would be meaningless.
 */
const MAX_SINGLE_FIELD_SEPARATION = 0.7;
const FRAUD_PREVALENCE_RANGE = [0.005, 0.05] as const;
const MAX_GIANT_COMPONENT_SHARE = 0.03;

export function inspectWorld(worldPath: string, labelsPath: string): InspectionReport {
  const world = new WorldReader(worldPath);
  const labels = new LabelReader(labelsPath);
  try {
    return buildReport(world, labels);
  } finally {
    world.close();
    labels.close();
  }
}

function buildReport(world: WorldReader, labels: LabelReader): InspectionReport {
  const transactions = world.all(TRANSACTIONS);
  const customers = world.all(CUSTOMERS);
  const cards = world.all(CARDS);
  const devices = world.all(DEVICES);
  const ips = world.all(IP_ADDRESSES);
  const sessions = world.all(SESSIONS);
  const merchants = new Map(world.all(MERCHANTS).map((m) => [m.merchantId, m]));
  const labelByTxn = new Map(labels.all(TRANSACTION_LABELS).map((l) => [l.txnId, l]));

  const isFraud = (txnId: string): boolean => labelByTxn.get(txnId)?.isFraud === true;
  const fraudFlags = transactions.map((txn) => isFraud(txn.txnId));
  const fraudCount = fraudFlags.filter(Boolean).length;

  const sessionById = new Map(sessions.map((s) => [s.sessionId, s]));
  const deviceById = new Map(devices.map((d) => [d.deviceId, d]));
  const ipById = new Map(ips.map((i) => [i.ipId, i]));
  const cardById = new Map(cards.map((c) => [c.cardId, c]));
  const customerById = new Map(customers.map((c) => [c.customerId, c]));

  const separations = computeSeparations(transactions, fraudFlags, {
    merchants,
    sessionById,
    deviceById,
    ipById,
    cardById,
    customerById,
  });

  const legitimateHours = transactions
    .filter((t) => !isFraud(t.txnId))
    .map((t) => String(new Date(t.atMs).getUTCHours()));
  // Transactions inside one coordinated burst share an hour by construction, so
  // comparing every fraud transaction would measure that clustering rather than a shift
  // in when fraud happens. Collapsing to one observation per scenario-day compares
  // independent timing decisions on both sides.
  const fraudHours = [
    ...new Map(
      transactions
        .filter((t) => isFraud(t.txnId))
        .map((t) => {
          const label = labelByTxn.get(t.txnId);
          const day = Math.floor(t.atMs / DAY_MS);
          const hour = new Date(t.atMs).getUTCHours();
          return [`${label?.scenarioId ?? t.txnId}:${day}:${hour}`, String(hour)] as const;
        }),
    ).values(),
  ];
  const hourDivergence = categoricalDivergence(
    counted(fraudHours, (v) => v),
    counted(legitimateHours, (v) => v),
  );
  const hourNullBound = divergenceUnderNull(legitimateHours, fraudHours.length);

  const components = entityComponents(customers, cards, sessions);
  const largestComponentShare = components.largest / Math.max(1, customers.length);

  const worstSeparation = separations[0];
  const checks: Check[] = [
    {
      name: "no single field separates the classes",
      value: worstSeparation ? worstSeparation[1].toFixed(3) : "n/a",
      bound: `< ${MAX_SINGLE_FIELD_SEPARATION}`,
      passed: (worstSeparation?.[1] ?? 0) < MAX_SINGLE_FIELD_SEPARATION,
      ...(worstSeparation ? { detail: `worst field: ${worstSeparation[0]}` } : {}),
    },
    {
      name: "fraud hour-of-day is within sampling noise",
      value: hourDivergence.toFixed(4),
      bound: `< ${hourNullBound.toFixed(4)}`,
      passed: hourDivergence < hourNullBound,
      detail: "bound is the 95th percentile of the same-distribution null",
    },
    {
      name: "fraud prevalence is realistic",
      value: (fraudCount / transactions.length).toFixed(4),
      bound: `${FRAUD_PREVALENCE_RANGE[0]}–${FRAUD_PREVALENCE_RANGE[1]}`,
      passed:
        fraudCount / transactions.length >= FRAUD_PREVALENCE_RANGE[0] &&
        fraudCount / transactions.length <= FRAUD_PREVALENCE_RANGE[1],
    },
    {
      name: "no giant entity-graph component",
      value: largestComponentShare.toFixed(4),
      bound: `< ${MAX_GIANT_COMPONENT_SHARE}`,
      passed: largestComponentShare < MAX_GIANT_COMPONENT_SHARE,
      detail: `largest component: ${components.largest} customers`,
    },
    {
      name: "identifiers carry no class signal",
      value: idPatternLeak(transactions, fraudFlags).toFixed(3),
      bound: `< ${MAX_SINGLE_FIELD_SEPARATION}`,
      passed: idPatternLeak(transactions, fraudFlags) < MAX_SINGLE_FIELD_SEPARATION,
    },
    {
      name: "every fraud family is represented",
      value: String(
        new Set([...labelByTxn.values()].filter((l) => l.isFraud).map((l) => l.family)).size,
      ),
      bound: "= 4",
      passed:
        new Set([...labelByTxn.values()].filter((l) => l.isFraud).map((l) => l.family)).size === 4,
    },
    {
      name: "hard negatives are present",
      value: String([...labelByTxn.values()].filter((l) => l.decoyKind !== null).length),
      bound: "> 0",
      passed: [...labelByTxn.values()].some((l) => l.decoyKind !== null),
    },
    {
      name: "no dispute precedes its transaction",
      value: String(disputesBeforeTransaction(world)),
      bound: "= 0",
      passed: disputesBeforeTransaction(world) === 0,
    },
  ];

  return {
    counts: {
      customers: customers.length,
      merchants: merchants.size,
      cards: cards.length,
      devices: devices.length,
      ipAddresses: ips.length,
      sessions: sessions.length,
      transactions: transactions.length,
      fraudTransactions: fraudCount,
      disputes: world.count(DISPUTES.table),
      profileChanges: world.count(PROFILE_CHANGES.table),
    },
    distributions: buildDistributions(transactions, fraudFlags, labelByTxn, sessions, devices, ips),
    singleFieldSeparation: separations,
    checks,
    passed: checks.every((check) => check.passed),
  };
}

interface Lookups {
  merchants: Map<
    string,
    { avgTicketMinor: number; category: string; baselineDisputeRateBps: number }
  >;
  sessionById: Map<
    string,
    { deviceId: string; ipId: string; startedAtMs: number; endedAtMs: number }
  >;
  deviceById: Map<
    string,
    { firstSeenAtMs: number; automationSignals: boolean; fingerprint: string | null }
  >;
  ipById: Map<
    string,
    { isDatacenter: boolean; vpnSuspected: boolean; country: string | null; asn: number }
  >;
  cardById: Map<string, { bin: string; funding: string; issuerCountry: string; addedAtMs: number }>;
  customerById: Map<string, { signupAtMs: number; kycLevel: number }>;
}

/**
 * Every field a probe could plausibly read, scored for how well it separates the
 * classes on its own. Run over all fields automatically so a tell nobody anticipated
 * still surfaces.
 */
function computeSeparations(
  transactions: readonly { txnId: string; [k: string]: unknown }[],
  fraudFlags: readonly boolean[],
  lookups: Lookups,
): (readonly [string, number])[] {
  const features: Record<string, (txn: Record<string, unknown>) => number> = {
    amountMinor: (t) => t.amountMinor as number,
    amountVsMerchantTicket: (t) => {
      const merchant = lookups.merchants.get(t.merchantId as string);
      return merchant ? (t.amountMinor as number) / merchant.avgTicketMinor : 0;
    },
    hourOfDay: (t) => new Date(t.atMs as number).getUTCHours(),
    dayOfWeek: (t) => new Date(t.atMs as number).getUTCDay(),
    isDeclined: (t) => (t.status === "declined" ? 1 : 0),
    avsUnavailable: (t) => (t.avsResult === "unavailable" ? 1 : 0),
    cvvFail: (t) => (t.cvvResult === "fail" ? 1 : 0),
    threeDsRequested: (t) => (t.threeDsResult === "not_requested" ? 0 : 1),
    hasShippingCity: (t) => (t.shippingCity === null ? 0 : 1),
    descriptionLength: (t) => (t.description as string).length,
    merchantDisputeRate: (t) =>
      lookups.merchants.get(t.merchantId as string)?.baselineDisputeRateBps ?? 0,
    deviceAgeDays: (t) => {
      const session = lookups.sessionById.get(t.sessionId as string);
      const device = session ? lookups.deviceById.get(session.deviceId) : undefined;
      return device ? ((t.atMs as number) - device.firstSeenAtMs) / DAY_MS : 0;
    },
    deviceAutomation: (t) => {
      const session = lookups.sessionById.get(t.sessionId as string);
      const device = session ? lookups.deviceById.get(session.deviceId) : undefined;
      return device?.automationSignals ? 1 : 0;
    },
    fingerprintMissing: (t) => {
      const session = lookups.sessionById.get(t.sessionId as string);
      const device = session ? lookups.deviceById.get(session.deviceId) : undefined;
      return device && device.fingerprint === null ? 1 : 0;
    },
    ipDatacenter: (t) => {
      const session = lookups.sessionById.get(t.sessionId as string);
      const ip = session ? lookups.ipById.get(session.ipId) : undefined;
      return ip?.isDatacenter ? 1 : 0;
    },
    ipGeoMissing: (t) => {
      const session = lookups.sessionById.get(t.sessionId as string);
      const ip = session ? lookups.ipById.get(session.ipId) : undefined;
      return ip && ip.country === null ? 1 : 0;
    },
    cardAgeDays: (t) => {
      const card = lookups.cardById.get(t.cardId as string);
      return card ? ((t.atMs as number) - card.addedAtMs) / DAY_MS : 0;
    },
    cardForeignIssuer: (t) =>
      lookups.cardById.get(t.cardId as string)?.issuerCountry === "IN" ? 0 : 1,
    accountAgeDays: (t) => {
      const customer = lookups.customerById.get(t.customerId as string);
      return customer ? ((t.atMs as number) - customer.signupAtMs) / DAY_MS : 0;
    },
    kycLevel: (t) => lookups.customerById.get(t.customerId as string)?.kycLevel ?? 0,
    sessionDurationMinutes: (t) => {
      const session = lookups.sessionById.get(t.sessionId as string);
      return session ? (session.endedAtMs - session.startedAtMs) / 60_000 : 0;
    },
  };

  return Object.entries(features)
    .map(
      ([name, extract]) =>
        [
          name,
          separation(
            transactions.map((txn) => extract(txn as Record<string, unknown>)),
            fraudFlags,
          ),
        ] as const,
    )
    .sort((a, b) => b[1] - a[1]);
}

/** Identifiers are content hashes; any separation here would mean the namespace leaks. */
function idPatternLeak(
  transactions: readonly { txnId: string }[],
  fraudFlags: readonly boolean[],
): number {
  const numeric = transactions.map((txn) => Number.parseInt(txn.txnId.slice(4, 12), 16));
  return separation(numeric, fraudFlags);
}

function disputesBeforeTransaction(world: WorldReader): number {
  const txnTimes = new Map(world.all(TRANSACTIONS).map((t) => [t.txnId, t.atMs]));
  return world.all(DISPUTES).filter((d) => (txnTimes.get(d.txnId) ?? 0) >= d.openedAtMs).length;
}

/**
 * Connected components over strong links only — shared device or shared payment
 * instrument. Shared IPs are excluded deliberately: a campus NAT would merge hundreds
 * of unrelated students into one component and make the structure meaningless.
 */
function entityComponents(
  customers: readonly { customerId: string }[],
  cards: readonly { cardId: string; customerId: string }[],
  sessions: readonly { customerId: string | null; deviceId: string }[],
): { largest: number; count: number } {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) as string;
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const customer of customers) parent.set(customer.customerId, customer.customerId);

  const customersByDevice = new Map<string, Set<string>>();
  for (const session of sessions) {
    if (!session.customerId) continue;
    const set = customersByDevice.get(session.deviceId) ?? new Set<string>();
    set.add(session.customerId);
    customersByDevice.set(session.deviceId, set);
  }
  for (const set of customersByDevice.values()) {
    const members = [...set];
    for (let i = 1; i < members.length; i += 1) {
      union(members[0] as string, members[i] as string);
    }
  }

  const customersByBin = new Map<string, Set<string>>();
  for (const card of cards) {
    const key = card.cardId;
    const set = customersByBin.get(key) ?? new Set<string>();
    set.add(card.customerId);
    customersByBin.set(key, set);
  }

  const sizes = new Map<string, number>();
  for (const customer of customers) {
    const root = find(customer.customerId);
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  return { largest: Math.max(0, ...sizes.values()), count: sizes.size };
}

function buildDistributions(
  transactions: readonly {
    txnId: string;
    amountMinor: number;
    atMs: number;
    customerId: string | null;
  }[],
  fraudFlags: readonly boolean[],
  labelByTxn: ReadonlyMap<
    string,
    {
      isFraud: boolean;
      family: string | null;
      variant: string | null;
      decoyKind: string | null;
      archetype: string | null;
    }
  >,
  sessions: readonly {
    deviceId: string;
    ipId: string;
    customerId: string | null;
    startedAtMs: number;
    endedAtMs: number;
  }[],
  devices: readonly unknown[],
  ips: readonly unknown[],
): Distribution[] {
  const amounts = transactions.map((t) => t.amountMinor).sort((a, b) => a - b);
  const fraudAmounts = transactions.filter((_, i) => fraudFlags[i]).map((t) => t.amountMinor);
  const legitAmounts = transactions.filter((_, i) => !fraudFlags[i]).map((t) => t.amountMinor);

  const perCustomer = counted(
    transactions.filter((t) => t.customerId !== null),
    (t) => t.customerId as string,
  );
  const customersPerDevice = new Map<string, Set<string>>();
  const customersPerIp = new Map<string, Set<string>>();
  for (const session of sessions) {
    if (!session.customerId) continue;
    const dset = customersPerDevice.get(session.deviceId) ?? new Set<string>();
    dset.add(session.customerId);
    customersPerDevice.set(session.deviceId, dset);
    const iset = customersPerIp.get(session.ipId) ?? new Set<string>();
    iset.add(session.customerId);
    customersPerIp.set(session.ipId, iset);
  }
  const deviceSharing = [...customersPerDevice.values()].map((s) => s.size).sort((a, b) => a - b);
  const ipSharing = [...customersPerIp.values()].map((s) => s.size).sort((a, b) => a - b);
  const sessionMinutes = sessions
    .map((s) => (s.endedAtMs - s.startedAtMs) / 60_000)
    .sort((a, b) => a - b);

  const families = counted(
    [...labelByTxn.values()].filter((l) => l.isFraud),
    (l) => `${l.family}/${l.variant}`,
  );
  const decoys = counted(
    [...labelByTxn.values()].filter((l) => l.decoyKind !== null),
    (l) => l.decoyKind as string,
  );

  const rupees = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN")}`;

  return [
    {
      name: "transaction amount (all)",
      rows: [
        ["p10", rupees(quantile(amounts, 0.1))],
        ["median", rupees(quantile(amounts, 0.5))],
        ["p90", rupees(quantile(amounts, 0.9))],
        ["p99", rupees(quantile(amounts, 0.99))],
        ["median fraud", rupees(median(fraudAmounts))],
        ["median legitimate", rupees(median(legitAmounts))],
      ],
    },
    {
      name: "transactions per customer",
      rows: [
        [
          "p10",
          quantile(
            [...perCustomer.values()].sort((a, b) => a - b),
            0.1,
          ).toFixed(0),
        ],
        [
          "median",
          quantile(
            [...perCustomer.values()].sort((a, b) => a - b),
            0.5,
          ).toFixed(0),
        ],
        [
          "p90",
          quantile(
            [...perCustomer.values()].sort((a, b) => a - b),
            0.9,
          ).toFixed(0),
        ],
        ["max", String(Math.max(...perCustomer.values()))],
      ],
    },
    {
      name: "customers per device",
      rows: [
        [
          "single-customer devices",
          `${((deviceSharing.filter((n) => n === 1).length / deviceSharing.length) * 100).toFixed(1)}%`,
        ],
        ["p99", quantile(deviceSharing, 0.99).toFixed(0)],
        ["max", String(deviceSharing[deviceSharing.length - 1] ?? 0)],
      ],
    },
    {
      name: "customers per IP",
      rows: [
        ["median", quantile(ipSharing, 0.5).toFixed(0)],
        ["p99", quantile(ipSharing, 0.99).toFixed(0)],
        ["max", String(ipSharing[ipSharing.length - 1] ?? 0)],
      ],
    },
    {
      name: "session duration (minutes)",
      rows: [
        ["p10", quantile(sessionMinutes, 0.1).toFixed(1)],
        ["median", quantile(sessionMinutes, 0.5).toFixed(1)],
        ["p90", quantile(sessionMinutes, 0.9).toFixed(1)],
      ],
    },
    {
      name: "fraud by family and variant",
      rows: [...families.entries()].sort().map(([k, v]) => [k, String(v)] as const),
    },
    {
      name: "hard negatives by cohort",
      rows: [...decoys.entries()].sort().map(([k, v]) => [k, String(v)] as const),
    },
    {
      name: "entity counts",
      rows: [
        ["devices", String(devices.length)],
        ["ip addresses", String(ips.length)],
        [
          "span (days)",
          String(
            Math.round(
              (Math.max(...transactions.map((t) => t.atMs)) -
                Math.min(...transactions.map((t) => t.atMs))) /
                DAY_MS,
            ),
          ),
        ],
        ["peak hour (UTC)", String(peakHour(transactions))],
      ],
    },
  ];
}

function peakHour(transactions: readonly { atMs: number }[]): number {
  const byHour = new Array<number>(24).fill(0);
  for (const txn of transactions) {
    const hour = new Date(txn.atMs).getUTCHours();
    byHour[hour] = (byHour[hour] as number) + 1;
  }
  return byHour.indexOf(Math.max(...byHour));
}

export function formatReport(report: InspectionReport): string {
  const lines: string[] = [];
  lines.push("ENTITY COUNTS");
  for (const [name, count] of Object.entries(report.counts)) {
    lines.push(`  ${name.padEnd(20)}${count.toLocaleString("en-IN")}`);
  }

  for (const distribution of report.distributions) {
    lines.push("", distribution.name.toUpperCase());
    for (const [label, value] of distribution.rows) {
      lines.push(`  ${label.padEnd(26)}${value}`);
    }
  }

  lines.push("", "SINGLE-FIELD SEPARATION (0.5 = useless alone; high = a shortcut)");
  for (const [name, value] of report.singleFieldSeparation.slice(0, 10)) {
    const bar = "#".repeat(Math.round((value - 0.5) * 60));
    lines.push(`  ${name.padEnd(26)}${value.toFixed(3)}  ${bar}`);
  }

  lines.push("", "CHECKS");
  for (const check of report.checks) {
    const status = check.passed ? "PASS" : "FAIL";
    const detail = check.detail ? `  (${check.detail})` : "";
    lines.push(`  [${status}] ${check.name.padEnd(44)}${check.value} ${check.bound}${detail}`);
  }
  lines.push("", report.passed ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED");
  return lines.join("\n");
}

export { HOUR_MS };
