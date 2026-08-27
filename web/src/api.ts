export interface Finding {
  code: string;
  direction: "inculpatory" | "exculpatory";
  intensity: string;
  evidenceIds: string[];
  summary: string;
}

export interface SourceRef {
  table: string;
  id: string;
  hash: string;
}

export interface Evidence {
  evidenceId: string;
  probe: string;
  subjectType: string;
  subjectId: string;
  fromMs: number | null;
  toMs: number | null;
  sources: SourceRef[];
  payload: Record<string, unknown>;
  payloadHash: string;
}

export interface Contribution {
  feature: string;
  value: string;
  coefficient: string;
  logOdds: string;
}

export interface CaseArtifact {
  caseId: string;
  alert: { alertId: string; txnId: string; ruleId: string; raisedAtMs: number };
  worldRoot: string;
  plan: string[];
  subject: { txnId: string; hash: string };
  evidence: Evidence[];
  findings: Finding[];
  contributions: Contribution[];
  logOdds: string;
  fraudProbability: string;
  action: "confirm" | "escalate" | "clear";
  expectedCostMinor: number;
  modelHash: string;
  caseHash: string;
}

export interface Narration {
  text: string;
  source: "model" | "template";
  rejected: { text: string; reason: string }[];
}

export interface AlertSummary {
  alertId: string;
  txnId: string;
  ruleId: string;
  atMs: number;
  amountMinor: number;
  merchantId: string;
}

export interface Overview {
  world: Record<string, unknown>;
  worldRoot: string;
  transactions: number;
  alerts: number;
  alertRate: number;
  boundaries: { clearBelow: number; confirmAbove: number };
}

export interface CohortResult {
  name: string;
  count: number;
  blocked: number;
  caught: number;
  blockRate: number;
  catchRate: number;
}

export interface EvaluationReport {
  world: string;
  totalTransactions: number;
  alerts: number;
  alertRate: number;
  fraudInAlerts: number;
  casefile: {
    precision: number;
    recall: number;
    f1: number;
    falsePositiveRate: number;
    truePositives: number;
    falsePositives: number;
    trueNegatives: number;
    falseNegatives: number;
  };
  casefileCaught: { precision: number; recall: number; f1: number };
  endToEnd: {
    fraudInWorld: number;
    fraudReachingQueue: number;
    fraudBlocked: number;
    alertingRecall: number;
    endToEndBlockRate: number;
    invisibleToAlerting: CohortResult[];
  };
  prAuc: number;
  calibration: {
    brier: number;
    expectedCalibrationError: number;
    bins: { lower: number; upper: number; count: number; predicted: number; observed: number }[];
  };
  baselines: {
    name: string;
    description: string;
    metrics: { precision: number; recall: number; f1: number };
    costMinor: number;
  }[];
  perFamily: CohortResult[];
  perVariant: CohortResult[];
  decoyCohorts: CohortResult[];
  actionCounts: { confirm: number; escalate: number; clear: number };
  autoDecisionRate: number;
  analystHoursSaved: number;
  costs: {
    casefileMinor: number;
    rulesOnlyMinor: number;
    clearAllMinor: number;
    savedVsRulesMinor: number;
  };
}

export interface ReplayResult {
  status: "verified" | "integrity_failure" | "replay_mismatch";
  caseId?: string;
  caseHash?: string;
  evidenceCount?: number;
  recordsVerified?: number;
  message?: string;
  subject?: string;
  expected?: string;
  actual?: string;
}

export interface TransactionLabel {
  txnId: string;
  isFraud: boolean;
  family: string | null;
  variant: string | null;
  decoyKind: string | null;
  archetype: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json()) as T;
  if (!response.ok && response.status !== 409) {
    throw new Error((body as { error?: string }).error ?? response.statusText);
  }
  return body;
}

export const api = {
  overview: () => request<Overview>("/api/overview"),
  alerts: (limit = 300) => request<AlertSummary[]>(`/api/alerts?limit=${limit}`),
  case: (alertId: string) =>
    request<{ artifact: CaseArtifact; narration: Narration }>(`/api/cases/${alertId}`),
  evidence: (alertId: string, evidenceId: string) =>
    request<{ evidence: Evidence; records: { source: SourceRef; record: unknown }[] }>(
      `/api/cases/${alertId}/evidence/${evidenceId}`,
    ),
  replay: (alertId: string) =>
    request<ReplayResult>(`/api/cases/${alertId}/replay`, { method: "POST" }),
  evaluation: () => request<EvaluationReport>("/api/evaluation"),
  truth: (txnId: string) => request<TransactionLabel>(`/api/truth/${txnId}`),
};

export const rupees = (minor: number): string =>
  `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export const percent = (value: number, digits = 1): string => `${(value * 100).toFixed(digits)}%`;

export const shortHash = (hash: string): string => hash.replace("sha256:", "").slice(0, 12);

export const formatTime = (ms: number): string =>
  new Date(ms).toISOString().replace("T", " ").slice(0, 16);
