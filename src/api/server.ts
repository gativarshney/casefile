import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { raiseAlerts } from "../alerting/rules.js";
import { type CaseArtifact, investigate, readCase, writeCase } from "../case/artifact.js";
import { type EvaluationReport, evaluate } from "../eval/evaluate.js";
import { inspectWorld } from "../eval/inspect.js";
import { narrateCase } from "../llm/narrate.js";
import { providerFromEnvironment } from "../llm/provider.js";
import { ReplayMismatchError, replayCase } from "../replay/replay.js";
import { type FrozenModel, loadModel } from "../scoring/model.js";
import { decisionBoundaries } from "../verify/policy.js";
import { LabelReader, TRANSACTION_LABELS } from "../world/labels.js";
import { TRANSACTIONS } from "../world/schema.js";
import { type DatasetManifest, IntegrityError, WorldReader } from "../world/store.js";

export interface ServerOptions {
  readonly dataDirectory: string;
  readonly modelPath: string;
  /** Where opened cases are sealed. Replay verifies against these, never against a rebuild. */
  readonly artifactDirectory?: string;
}

interface AlertSummary {
  readonly alertId: string;
  readonly txnId: string;
  readonly ruleId: string;
  readonly atMs: number;
  readonly amountMinor: number;
  readonly merchantId: string;
}

/**
 * A read-only HTTP surface over the same functions the CLI uses.
 *
 * Nothing here can mutate the world or a sealed case: the API opens the store read-only
 * and every endpoint recomputes from source records, so the console is a viewer over
 * verifiable state rather than a second implementation of the decision logic.
 */
export function createServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  const manifestPath = join(options.dataDirectory, "dataset_manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`no world at ${options.dataDirectory}. Run: npm run casefile -- generate`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DatasetManifest;
  const model: FrozenModel = loadModel(options.modelPath);

  const worldPath = join(options.dataDirectory, "world.db");
  const labelsPath = join(options.dataDirectory, "labels.db");

  const withWorld = <T>(run: (reader: WorldReader) => T): T => {
    const reader = new WorldReader(worldPath);
    try {
      return run(reader);
    } finally {
      reader.close();
    }
  };

  const artifactDirectory = options.artifactDirectory ?? join(options.dataDirectory, "cases");
  let cachedEvaluation: EvaluationReport | undefined;

  /**
   * Seals a case the first time it is opened and returns the sealed copy thereafter.
   *
   * Replay is only meaningful against state that was committed *before* the world was
   * touched. Rebuilding the artifact at replay time would recompute its hashes from
   * whatever the records say now, so it could never detect a change — the check would
   * always pass and prove nothing.
   */
  const sealedCase = (alertId: string): CaseArtifact | undefined => {
    const path = join(artifactDirectory, `${alertId}.json`);
    if (existsSync(path)) return readCase(path);
    const artifact = withWorld((reader) => {
      const alert = raiseAlerts(reader).find((candidate) => candidate.alertId === alertId);
      if (!alert) return undefined;
      return investigate(reader, manifest, alert, model);
    });
    if (artifact) writeCase(path, artifact);
    return artifact;
  };

  app.get("/api/overview", () => {
    const alerts = withWorld(raiseAlerts);
    const transactions = withWorld((reader) => reader.count(TRANSACTIONS.table));
    return {
      world: manifest.provenance,
      worldRoot: manifest.worldRoot,
      modelHash: model.trainedOn,
      transactions,
      alerts: alerts.length,
      alertRate: alerts.length / Math.max(1, transactions),
      boundaries: decisionBoundaries(100_000),
    };
  });

  app.get<{ Querystring: { limit?: string } }>("/api/alerts", (request) => {
    const limit = Number(request.query.limit ?? 200);
    return withWorld((reader) => {
      const byTxn = new Map(reader.all(TRANSACTIONS).map((txn) => [txn.txnId, txn]));
      const summaries: AlertSummary[] = [];
      for (const alert of raiseAlerts(reader).slice(0, limit)) {
        const txn = byTxn.get(alert.txnId);
        if (!txn) continue;
        summaries.push({
          alertId: alert.alertId,
          txnId: alert.txnId,
          ruleId: alert.ruleId,
          atMs: alert.raisedAtMs,
          amountMinor: txn.amountMinor,
          merchantId: txn.merchantId,
        });
      }
      return summaries;
    });
  });

  app.get<{ Params: { alertId: string } }>("/api/cases/:alertId", async (request, reply) => {
    const artifact = sealedCase(request.params.alertId);
    if (!artifact) return reply.code(404).send({ error: "no such alert" });

    const narration = await narrateCase(artifact, providerFromEnvironment());
    return { artifact, narration, model: { featureNames: model.featureNames } };
  });

  /**
   * Resolves an evidence citation to the records behind it, so a reviewer can follow
   * verdict to claim to evidence to source row without leaving the interface.
   */
  app.get<{ Params: { alertId: string; evidenceId: string } }>(
    "/api/cases/:alertId/evidence/:evidenceId",
    (request, reply) => {
      const artifact = sealedCase(request.params.alertId);
      if (!artifact) return reply.code(404).send({ error: "no such alert" });
      const resolved = withWorld((reader) => {
        const evidence = artifact.evidence.find(
          (item) => item.evidenceId === request.params.evidenceId,
        );
        if (!evidence) return undefined;
        return {
          evidence,
          records: evidence.sources.map((source) => {
            const type = reader.recordTypeFor(source.table);
            return { source, record: reader.rawRecord(type, source.id) ?? null };
          }),
        };
      });
      if (!resolved) return reply.code(404).send({ error: "no such evidence" });
      return resolved;
    },
  );

  app.post<{ Params: { alertId: string } }>("/api/cases/:alertId/replay", (request, reply) => {
    const artifact = sealedCase(request.params.alertId);
    if (!artifact) return reply.code(404).send({ error: "no such alert" });
    try {
      const result = withWorld((reader) => replayCase(reader, manifest, artifact, model));
      return { status: "verified", ...result };
    } catch (error) {
      if (error instanceof IntegrityError) {
        return reply.code(409).send({
          status: "integrity_failure",
          message: error.message,
          subject: error.subject,
          expected: error.expected,
          actual: error.actual,
        });
      }
      if (error instanceof ReplayMismatchError) {
        return reply
          .code(409)
          .send({ status: "replay_mismatch", message: error.message, field: error.field });
      }
      throw error;
    }
  });

  app.get("/api/evaluation", () => {
    cachedEvaluation ??= evaluate(
      worldPath,
      labelsPath,
      manifest,
      model,
      String((manifest.provenance as Record<string, unknown>).spec ?? "world"),
    );
    return cachedEvaluation;
  });

  app.get("/api/data-quality", () => inspectWorld(worldPath, labelsPath));

  /**
   * Ground truth, exposed only so the console can show whether a decision was right.
   * The investigation path never reads it; this endpoint sits outside that boundary and
   * exists for the reviewer, not for the verifier.
   */
  app.get<{ Params: { txnId: string } }>("/api/truth/:txnId", (request, reply) => {
    const labels = new LabelReader(labelsPath);
    try {
      const label = labels.get(TRANSACTION_LABELS, request.params.txnId);
      if (!label) return reply.code(404).send({ error: "no label" });
      return label;
    } finally {
      labels.close();
    }
  });

  return app;
}
