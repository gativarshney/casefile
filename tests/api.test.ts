import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseSync from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/api/server.js";
import { buildTrainingSet, trainModel, writeModel } from "../src/eval/train.js";
import { generateWorld, testSpec } from "../src/world/generate/index.js";

let directory: string;
let app: FastifyInstance;
let worldPath: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "casefile-api-"));
  const generated = generateWorld({ spec: testSpec(), outputDirectory: directory });
  worldPath = generated.worldPath;
  const training = buildTrainingSet(generated.worldPath, generated.labelsPath);
  const { model } = trainModel(training, {
    world: "test",
    specDigest: "test",
    alerts: training.rows.length,
    positives: training.rows.filter((row) => row.isFraud).length,
  });
  const modelPath = join(directory, "model.json");
  writeModel(modelPath, model);
  app = createServer({ dataDirectory: directory, modelPath });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});

async function json<T>(url: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const response = await app.inject({ method, url });
  return response.json() as T;
}

async function firstAlertId(): Promise<string> {
  const alerts = await json<{ alertId: string }[]>("/api/alerts?limit=1");
  return alerts[0]?.alertId as string;
}

describe("overview and queue", () => {
  it("reports the size of the alert queue", async () => {
    const overview = await json<{ transactions: number; alerts: number }>("/api/overview");
    expect(overview.transactions).toBeGreaterThan(0);
    expect(overview.alerts).toBeGreaterThan(0);
    expect(overview.alerts).toBeLessThan(overview.transactions);
  });

  it("lists alerts with the detail the queue needs", async () => {
    const alerts =
      await json<{ alertId: string; ruleId: string; amountMinor: number }[]>("/api/alerts?limit=5");
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) {
      expect(alert.alertId).toMatch(/^alert_/);
      expect(alert.ruleId).toMatch(/^rule\./);
      expect(alert.amountMinor).toBeGreaterThan(0);
    }
  });

  it.each([
    "/api/cases/..%2F..%2Fescape",
    "/api/cases/alert_..%2F..%2Fescape",
    "/api/truth/..%2F..%2Fsecret",
  ])("refuses a path-traversal identifier: %s", async (url) => {
    // The identifier reaches a filesystem path, so a caller must not be able to steer a
    // read or a write outside the directory the server owns.
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("returns 404 for an unknown alert", async () => {
    expect((await app.inject({ method: "GET", url: "/api/cases/alert_nope" })).statusCode).toBe(
      404,
    );
  });
});

describe("cases", () => {
  it("returns an artifact whose findings cite evidence in the same case", async () => {
    const { artifact } = await json<{
      artifact: {
        findings: { evidenceIds: string[] }[];
        evidence: { evidenceId: string }[];
        action: string;
      };
    }>(`/api/cases/${await firstAlertId()}`);
    const known = new Set(artifact.evidence.map((item) => item.evidenceId));
    for (const finding of artifact.findings) {
      for (const id of finding.evidenceIds) expect(known).toContain(id);
    }
    expect(["confirm", "escalate", "clear"]).toContain(artifact.action);
  });

  it("always returns a grounded narration, with or without a model", async () => {
    const { narration } = await json<{ narration: { text: string; source: string } }>(
      `/api/cases/${await firstAlertId()}`,
    );
    expect(narration.text.length).toBeGreaterThan(0);
    expect(["model", "template"]).toContain(narration.source);
  });

  it("resolves an evidence citation to the records behind it", async () => {
    const alertId = await firstAlertId();
    const { artifact } = await json<{ artifact: { evidence: { evidenceId: string }[] } }>(
      `/api/cases/${alertId}`,
    );
    const evidenceId = artifact.evidence[0]?.evidenceId as string;
    const resolved = await json<{ records: { source: { hash: string }; record: unknown }[] }>(
      `/api/cases/${alertId}/evidence/${evidenceId}`,
    );
    expect(resolved.records.length).toBeGreaterThan(0);
    for (const entry of resolved.records) {
      expect(entry.source.hash).toMatch(/^sha256:/);
      expect(entry.record).not.toBeNull();
    }
  });

  it("returns the same sealed case on repeated opens", async () => {
    const alertId = await firstAlertId();
    const first = await json<{ artifact: { caseHash: string } }>(`/api/cases/${alertId}`);
    const second = await json<{ artifact: { caseHash: string } }>(`/api/cases/${alertId}`);
    expect(second.artifact.caseHash).toBe(first.artifact.caseHash);
  });
});

describe("replay through the API", () => {
  it("verifies an untouched case", async () => {
    const result = await json<{ status: string; recordsVerified: number }>(
      `/api/cases/${await firstAlertId()}/replay`,
      "POST",
    );
    expect(result.status).toBe("verified");
    expect(result.recordsVerified).toBeGreaterThan(0);
  });

  it("detects a modified source record", async () => {
    // Guards a real defect: an earlier version rebuilt the artifact at replay time, so
    // its hashes were recomputed from the tampered rows and the check always passed.
    // Replay must verify against state sealed before the world was touched.
    const alertId = await firstAlertId();
    const { artifact } = await json<{
      artifact: { evidence: { sources: { table: string; id: string }[] }[] };
    }>(`/api/cases/${alertId}`);
    const cited = artifact.evidence
      .flatMap((item) => item.sources)
      .find((source) => source.table === "sessions");
    if (!cited) throw new Error("expected the case to cite a session");

    const db = new DatabaseSync(worldPath);
    const row = db.prepare("SELECT endedAtMs FROM sessions WHERE sessionId = ?").get(cited.id) as {
      endedAtMs: number;
    };
    db.prepare("UPDATE sessions SET endedAtMs = ? WHERE sessionId = ?").run(
      row.endedAtMs + 60_000,
      cited.id,
    );
    db.close();

    const response = await app.inject({
      method: "POST",
      url: `/api/cases/${alertId}/replay`,
    });
    const result = response.json() as { status: string; subject: string; expected: string };
    expect(response.statusCode).toBe(409);
    expect(result.status).toBe("integrity_failure");
    expect(result.subject).toBe(`sessions:${cited.id}`);
    expect(result.expected).toMatch(/^sha256:/);

    const restore = new DatabaseSync(worldPath);
    restore
      .prepare("UPDATE sessions SET endedAtMs = ? WHERE sessionId = ?")
      .run(row.endedAtMs, cited.id);
    restore.close();
  });

  it("verifies again once the record is restored", async () => {
    const result = await json<{ status: string }>(
      `/api/cases/${await firstAlertId()}/replay`,
      "POST",
    );
    expect(result.status).toBe("verified");
  });
});

describe("reporting endpoints", () => {
  it("serves the evaluation report", async () => {
    const report = await json<{ casefile: { precision: number }; baselines: unknown[] }>(
      "/api/evaluation",
    );
    expect(report.casefile.precision).toBeGreaterThanOrEqual(0);
    expect(report.baselines.length).toBeGreaterThan(0);
  });

  it("serves the data-quality report", async () => {
    const report = await json<{ checks: { name: string }[] }>("/api/data-quality");
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it("serves ground truth for the console to show, outside the investigation path", async () => {
    const alertId = await firstAlertId();
    const { artifact } = await json<{ artifact: { subject: { txnId: string } } }>(
      `/api/cases/${alertId}`,
    );
    const truth = await json<{ txnId: string; isFraud: boolean }>(
      `/api/truth/${artifact.subject.txnId}`,
    );
    expect(truth.txnId).toBe(artifact.subject.txnId);
    expect(typeof truth.isFraud).toBe("boolean");
  });
});
