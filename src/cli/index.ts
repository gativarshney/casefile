#!/usr/bin/env -S npx tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { raiseAlerts } from "../alerting/rules.js";
import { type CaseArtifact, investigate, readCase, writeCase } from "../case/artifact.js";
import { evaluate } from "../eval/evaluate.js";
import { formatReport, inspectWorld } from "../eval/inspect.js";
import { formatEvaluation } from "../eval/report.js";
import { buildTrainingSet, trainModel, writeModel } from "../eval/train.js";
import { ReplayMismatchError, replayCase } from "../replay/replay.js";
import { type FrozenModel, loadModel } from "../scoring/model.js";
import { decisionBoundaries } from "../verify/policy.js";
import { developmentSpec, generateWorld, heldoutSpec } from "../world/generate/index.js";
import { type DatasetManifest, IntegrityError, WorldReader } from "../world/store.js";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { version: string };

const DEFAULT_DATA_DIR = "data/dev";
const DEFAULT_MODEL_PATH = "models/casefile.json";

function openWorld(directory: string): { reader: WorldReader; manifest: DatasetManifest } {
  const manifest = JSON.parse(
    readFileSync(join(directory, "dataset_manifest.json"), "utf8"),
  ) as DatasetManifest;
  return { reader: new WorldReader(join(directory, "world.db")), manifest };
}

function requireModel(path: string): FrozenModel {
  if (!existsSync(path)) {
    throw new Error(`no model at ${path}. Train one first: npm run casefile -- train`);
  }
  return loadModel(path);
}

const program = new Command()
  .name("casefile")
  .description("An investigating verifier for payment fraud alerts.")
  .version(packageJson.version);

program
  .command("generate")
  .description("Generate a synthetic payment world")
  .option("-o, --out <directory>", "output directory", DEFAULT_DATA_DIR)
  .option(
    "--heldout",
    "generate the held-out world instead: a different seed, a later window, disjoint " +
      "identifiers, and two attack mechanisms absent from development",
  )
  .action((options: { out: string; heldout?: boolean }) => {
    const spec = options.heldout ? heldoutSpec() : developmentSpec();
    const result = generateWorld({ spec, outputDirectory: options.out });
    process.stdout.write(`world      ${result.worldPath}\n`);
    process.stdout.write(`labels     ${result.labelsPath}\n`);
    process.stdout.write(`manifest   ${result.manifestPath}\n`);
    process.stdout.write(`world root ${result.manifest.worldRoot}\n`);
    for (const [table, count] of Object.entries(result.counts)) {
      process.stdout.write(`  ${table.padEnd(18)}${count}\n`);
    }
  });

program
  .command("inspect")
  .description("Report distributions and check the world for synthetic shortcuts")
  .option("-d, --data <directory>", "world directory", DEFAULT_DATA_DIR)
  .action((options: { data: string }) => {
    const report = inspectWorld(join(options.data, "world.db"), join(options.data, "labels.db"));
    process.stdout.write(`${formatReport(report)}\n`);
    if (!report.passed) process.exitCode = 5;
  });

program
  .command("train")
  .description("Fit and freeze the risk scorer on the development world")
  .option("-d, --data <directory>", "world directory", DEFAULT_DATA_DIR)
  .option("-o, --out <path>", "model output path", DEFAULT_MODEL_PATH)
  .action((options: { data: string; out: string }) => {
    const manifest = JSON.parse(
      readFileSync(join(options.data, "dataset_manifest.json"), "utf8"),
    ) as DatasetManifest & { provenance: Record<string, string> };

    const training = buildTrainingSet(
      join(options.data, "world.db"),
      join(options.data, "labels.db"),
    );
    const result = trainModel(training, {
      world: String(manifest.provenance.spec ?? "development"),
      specDigest: String(manifest.provenance.specDigest ?? ""),
      alerts: training.rows.length,
      positives: training.rows.filter((row) => row.isFraud).length,
    });

    writeModel(options.out, result.model);
    process.stdout.write(`alerts           ${training.rows.length}\n`);
    process.stdout.write(`  fitting fold   ${result.fitRows} (${result.fitPositives} fraud)\n`);
    process.stdout.write(`  calibration    ${result.calibrateRows}\n`);
    process.stdout.write(`newton steps     ${result.iterations}\n`);
    process.stdout.write(`model            ${options.out}\n\n`);
    process.stdout.write("coefficients (log-odds per unit of finding intensity)\n");
    const ranked = result.model.featureNames
      .map((name, index) => [name, Number(result.model.coefficients[index])] as const)
      .filter(([, value]) => Math.abs(value) > 0.005)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    for (const [name, value] of ranked) {
      process.stdout.write(`  ${name.padEnd(36)}${value >= 0 ? "+" : ""}${value.toFixed(4)}\n`);
    }
  });

program
  .command("evaluate")
  .description("Measure triage performance against ground truth")
  .option("-d, --data <directory>", "world directory", DEFAULT_DATA_DIR)
  .option("-m, --model <path>", "frozen model", DEFAULT_MODEL_PATH)
  .option("--json <path>", "also write the full report as JSON")
  .action((options: { data: string; model: string; json?: string }) => {
    const model = requireModel(options.model);
    const manifest = JSON.parse(
      readFileSync(join(options.data, "dataset_manifest.json"), "utf8"),
    ) as DatasetManifest & { provenance: Record<string, string> };

    const report = evaluate(
      join(options.data, "world.db"),
      join(options.data, "labels.db"),
      manifest,
      model,
      String(manifest.provenance.spec ?? options.data),
    );
    process.stdout.write(`${formatEvaluation(report)}
`);
    if (options.json) {
      mkdirSync(dirname(options.json), { recursive: true });
      writeFileSync(
        options.json,
        `${JSON.stringify(report, null, 2)}
`,
        "utf8",
      );
      process.stdout.write(`
report written to ${options.json}
`);
    }
  });

program
  .command("alerts")
  .description("List the alerts the upstream rules engine raises")
  .option("-d, --data <directory>", "world directory", DEFAULT_DATA_DIR)
  .option("-n, --limit <count>", "maximum alerts to print", "20")
  .action((options: { data: string; limit: string }) => {
    const { reader } = openWorld(options.data);
    const alerts = raiseAlerts(reader);
    reader.close();
    for (const alert of alerts.slice(0, Number(options.limit))) {
      process.stdout.write(`${alert.alertId}  ${alert.ruleId.padEnd(38)}${alert.txnId}\n`);
    }
    process.stdout.write(`\n${alerts.length} alert(s)\n`);
  });

program
  .command("investigate")
  .description("Investigate an alert and seal a case artifact")
  .argument("[alertId]", "alert to investigate; defaults to the first raised")
  .option("-d, --data <directory>", "world directory", DEFAULT_DATA_DIR)
  .option("-m, --model <path>", "frozen model", DEFAULT_MODEL_PATH)
  .option("-o, --out <directory>", "case output directory", "artifacts")
  .action((alertId: string | undefined, options: { data: string; model: string; out: string }) => {
    const model = requireModel(options.model);
    const { reader, manifest } = openWorld(options.data);
    try {
      const alerts = raiseAlerts(reader);
      const alert = alertId ? alerts.find((a) => a.alertId === alertId) : alerts[0];
      if (!alert) throw new Error(alertId ? `no such alert: ${alertId}` : "no alerts were raised");

      const artifact = investigate(reader, manifest, alert, model);
      const path = join(options.out, `${artifact.caseId}.json`);
      writeCase(path, artifact);
      printCase(artifact);
      process.stdout.write(`\nsealed to ${path}\n`);
    } finally {
      reader.close();
    }
  });

program
  .command("replay")
  .description("Replay a sealed case and verify it against the live world")
  .argument("<casePath>", "path to a case artifact")
  .option("-d, --data <directory>", "world directory", DEFAULT_DATA_DIR)
  .option("-m, --model <path>", "frozen model", DEFAULT_MODEL_PATH)
  .action((casePath: string, options: { data: string; model: string }) => {
    const model = requireModel(options.model);
    const { reader, manifest } = openWorld(options.data);
    try {
      const result = replayCase(reader, manifest, readCase(casePath), model);
      process.stdout.write(`OK  ${result.caseId}\n`);
      process.stdout.write(`    case hash        ${result.caseHash}\n`);
      process.stdout.write(`    evidence         ${result.evidenceCount}\n`);
      process.stdout.write(`    records verified ${result.recordsVerified}\n`);
    } finally {
      reader.close();
    }
  });

function printCase(artifact: CaseArtifact): void {
  const probability = Number(artifact.fraudProbability);
  process.stdout.write(`case     ${artifact.caseId}\n`);
  process.stdout.write(`alert    ${artifact.alert.alertId} (${artifact.alert.ruleId})\n`);
  process.stdout.write(
    `verdict  ${artifact.action.toUpperCase()}   p(fraud) ${(probability * 100).toFixed(1)}%   ` +
      `expected cost ₹${(artifact.expectedCostMinor / 100).toFixed(0)}\n\n`,
  );

  const byCode = new Map(artifact.contributions.map((c) => [c.feature, Number(c.logOdds)]));
  for (const [label, direction] of [
    ["AGAINST", "inculpatory"],
    ["FOR", "exculpatory"],
  ] as const) {
    const group = artifact.findings.filter((f) => f.direction === direction);
    if (group.length === 0) continue;
    process.stdout.write(`  ${label}\n`);
    for (const finding of group) {
      const contribution = byCode.get(finding.code) ?? 0;
      const sign = contribution >= 0 ? "+" : "";
      process.stdout.write(
        `    ${sign}${contribution.toFixed(2).padStart(6)}  ${finding.code.padEnd(34)}${finding.summary}\n`,
      );
      process.stdout.write(`${" ".repeat(12)}cites ${finding.evidenceIds.join(", ")}\n`);
    }
  }

  const cited = artifact.evidence.reduce((total, item) => total + item.sources.length, 0);
  const boundaries = decisionBoundaries(100_000);
  process.stdout.write(
    `\n  ${artifact.evidence.length} evidence item(s), ${cited} source record(s)\n`,
  );
  process.stdout.write(
    `  policy at ₹1,000: clear below ${(boundaries.clearBelow * 100).toFixed(1)}%, ` +
      `confirm above ${(boundaries.confirmAbove * 100).toFixed(1)}%\n`,
  );
  process.stdout.write(`  model ${artifact.modelHash}\n`);
  process.stdout.write(`  case  ${artifact.caseHash}\n`);
}

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof IntegrityError) {
    process.stderr.write(`\nINTEGRITY FAILURE\n${error.message}\n`);
    process.exitCode = 3;
    return;
  }
  if (error instanceof ReplayMismatchError) {
    process.stderr.write(`\nREPLAY MISMATCH\n${error.message}\n`);
    process.exitCode = 4;
    return;
  }
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
