#!/usr/bin/env -S npx tsx
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { raiseAlerts } from "../alerting/rules.js";
import { type CaseArtifact, investigate, readCase, writeCase } from "../case/artifact.js";
import { formatReport, inspectWorld } from "../eval/inspect.js";
import { ReplayMismatchError, replayCase } from "../replay/replay.js";
import { developmentSpec, generateWorld } from "../world/generate/index.js";
import { type DatasetManifest, IntegrityError, WorldReader } from "../world/store.js";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { version: string };

const DEFAULT_DATA_DIR = "data/dev";

function openWorld(directory: string): { reader: WorldReader; manifest: DatasetManifest } {
  const manifest = JSON.parse(
    readFileSync(join(directory, "dataset_manifest.json"), "utf8"),
  ) as DatasetManifest;
  return { reader: new WorldReader(join(directory, "world.db")), manifest };
}

const program = new Command()
  .name("casefile")
  .description("An investigating verifier for payment fraud alerts.")
  .version(packageJson.version);

program
  .command("generate")
  .description("Generate the synthetic development payment world")
  .option("-o, --out <directory>", "output directory", DEFAULT_DATA_DIR)
  .action((options: { out: string }) => {
    const result = generateWorld({ spec: developmentSpec(), outputDirectory: options.out });
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
    process.stdout.write(`${formatReport(report)}
`);
    if (!report.passed) process.exitCode = 5;
  });

program
  .command("alerts")
  .description("List the alerts the upstream rules engine raises")
  .option("-d, --data <directory>", "world directory", DEFAULT_DATA_DIR)
  .action((options: { data: string }) => {
    const { reader } = openWorld(options.data);
    const alerts = raiseAlerts(reader);
    reader.close();
    for (const alert of alerts) {
      process.stdout.write(`${alert.alertId}  ${alert.ruleId}  ${alert.txnId}\n`);
    }
    process.stdout.write(`\n${alerts.length} alert(s)\n`);
  });

program
  .command("investigate")
  .description("Investigate an alert and seal a case artifact")
  .argument("[alertId]", "alert to investigate; defaults to the first raised")
  .option("-d, --data <directory>", "world directory", DEFAULT_DATA_DIR)
  .option("-o, --out <directory>", "case output directory", "artifacts")
  .action((alertId: string | undefined, options: { data: string; out: string }) => {
    const { reader, manifest } = openWorld(options.data);
    const alerts = raiseAlerts(reader);
    const alert = alertId ? alerts.find((a) => a.alertId === alertId) : alerts[0];
    if (!alert) {
      reader.close();
      throw new Error(alertId ? `no such alert: ${alertId}` : "no alerts were raised");
    }
    const artifact = investigate(reader, manifest, alert);
    reader.close();

    const path = join(options.out, `${artifact.caseId}.json`);
    writeCase(path, artifact);
    printCase(artifact);
    process.stdout.write(`\nsealed to ${path}\n`);
  });

program
  .command("replay")
  .description("Replay a sealed case and verify it against the live world")
  .argument("<casePath>", "path to a case artifact")
  .option("-d, --data <directory>", "world directory", DEFAULT_DATA_DIR)
  .action((casePath: string, options: { data: string }) => {
    const { reader, manifest } = openWorld(options.data);
    try {
      const result = replayCase(reader, manifest, readCase(casePath));
      process.stdout.write(`OK  ${result.caseId}\n`);
      process.stdout.write(`    case hash        ${result.caseHash}\n`);
      process.stdout.write(`    evidence         ${result.evidenceCount}\n`);
      process.stdout.write(`    records verified ${result.recordsVerified}\n`);
    } finally {
      reader.close();
    }
  });

function printCase(artifact: CaseArtifact): void {
  process.stdout.write(`case     ${artifact.caseId}\n`);
  process.stdout.write(`alert    ${artifact.alert.alertId} (${artifact.alert.ruleId})\n`);
  process.stdout.write(`verdict  ${artifact.action.toUpperCase()}  index ${artifact.score}\n\n`);
  for (const finding of artifact.findings) {
    const sign = finding.direction === "inculpatory" ? "+" : "-";
    process.stdout.write(
      `  ${sign} ${finding.code.padEnd(32)}${String(finding.weight).padStart(4)}  ${finding.summary}\n`,
    );
    process.stdout.write(`      cites ${finding.evidenceIds.join(", ")}\n`);
  }
  const cited = artifact.evidence.reduce((total, item) => total + item.sources.length, 0);
  process.stdout.write(
    `\n  ${artifact.evidence.length} evidence item(s), ${cited} source record(s)\n`,
  );
  process.stdout.write(`  case hash ${artifact.caseHash}\n`);
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
