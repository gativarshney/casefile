import type { EvaluationReport } from "./evaluate.js";

const rupees = (minor: number): string => `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;
const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

export function formatEvaluation(report: EvaluationReport): string {
  const lines: string[] = [];

  lines.push(`WORLD: ${report.world}`);
  lines.push(`  world root       ${report.worldRoot}`);
  lines.push(`  model            ${report.modelHash}`);
  lines.push(`  transactions     ${report.totalTransactions.toLocaleString("en-IN")}`);
  lines.push(
    `  alerts           ${report.alerts.toLocaleString("en-IN")} (${percent(report.alertRate)} of volume, ${report.fraudInAlerts} fraudulent)`,
  );

  const c = report.casefile;
  const caught = report.casefileCaught;
  lines.push("", "CASEFILE — triage of the alert queue");
  lines.push("  blocking outright (confirm counted as positive)");
  lines.push(`    precision      ${c.precision.toFixed(3)}`);
  lines.push(`    recall         ${c.recall.toFixed(3)}`);
  lines.push(`    F1             ${c.f1.toFixed(3)}`);
  lines.push("  not letting fraud through (confirm or escalate)");
  lines.push(`    precision      ${caught.precision.toFixed(3)}`);
  lines.push(`    recall         ${caught.recall.toFixed(3)}`);
  lines.push(`    F1             ${caught.f1.toFixed(3)}`);
  lines.push(`  PR-AUC           ${report.prAuc.toFixed(3)}`);
  lines.push(`  false positives  ${c.falsePositives} (FPR ${percent(c.falsePositiveRate)})`);
  lines.push(`  false negatives  ${c.falseNegatives}`);
  lines.push(
    `  confusion        TP ${c.truePositives}  FP ${c.falsePositives}  TN ${c.trueNegatives}  FN ${c.falseNegatives}`,
  );

  lines.push("", "ACTIONS");
  lines.push(`  confirm          ${report.actionCounts.confirm}`);
  lines.push(`  escalate         ${report.actionCounts.escalate}`);
  lines.push(`  clear            ${report.actionCounts.clear}`);
  lines.push(`  decided without analyst ${percent(report.autoDecisionRate)}`);
  lines.push(`  analyst hours saved ${report.analystHoursSaved.toFixed(0)}`);

  lines.push("", "COST (lower is better)");
  lines.push(`  casefile         ${rupees(report.costs.casefileMinor)}`);
  lines.push(`  rules only       ${rupees(report.costs.rulesOnlyMinor)}`);
  lines.push(`  clear everything ${rupees(report.costs.clearAllMinor)}`);
  lines.push(
    `  saved vs rules   ${rupees(report.costs.savedVsRulesMinor)} (${percent(report.costs.savedVsRulesMinor / Math.max(1, report.costs.rulesOnlyMinor))})`,
  );

  lines.push("", "BASELINES");
  lines.push(
    `  ${"name".padEnd(18)}${"prec".padStart(6)}${"rec".padStart(7)}${"F1".padStart(7)}${"cost".padStart(14)}`,
  );
  for (const baseline of report.baselines) {
    lines.push(
      `  ${baseline.name.padEnd(18)}${baseline.metrics.precision.toFixed(3).padStart(6)}` +
        `${baseline.metrics.recall.toFixed(3).padStart(7)}${baseline.metrics.f1.toFixed(3).padStart(7)}` +
        `${rupees(baseline.costMinor).padStart(14)}`,
    );
  }
  lines.push(
    `  ${"casefile".padEnd(18)}${c.precision.toFixed(3).padStart(6)}${c.recall.toFixed(3).padStart(7)}` +
      `${c.f1.toFixed(3).padStart(7)}${rupees(report.costs.casefileMinor).padStart(14)}`,
  );

  const cohortTable = (title: string, rows: readonly (typeof report.perFamily)[number][]): void => {
    lines.push("", title);
    lines.push(
      `  ${"cohort".padEnd(26)}${"n".padStart(5)}${"blocked".padStart(10)}${"caught".padStart(10)}`,
    );
    for (const cohort of rows) {
      lines.push(
        `  ${cohort.name.padEnd(26)}${String(cohort.count).padStart(5)}` +
          `${percent(cohort.blockRate).padStart(10)}${percent(cohort.catchRate).padStart(10)}`,
      );
    }
  };

  cohortTable("BY FRAUD FAMILY", report.perFamily);
  cohortTable("BY MECHANISM", report.perVariant);

  if (report.decoyCohorts.length > 0) {
    cohortTable(
      "HARD NEGATIVES — legitimate behaviour that resembles fraud (lower is better)",
      report.decoyCohorts,
    );
  }

  lines.push("", "CALIBRATION");
  lines.push(`  Brier score      ${report.calibration.brier.toFixed(4)}`);
  lines.push(`  expected error   ${report.calibration.expectedCalibrationError.toFixed(4)}`);
  lines.push(
    `  ${"bin".padEnd(14)}${"n".padStart(6)}${"predicted".padStart(11)}${"observed".padStart(10)}`,
  );
  for (const bin of report.calibration.bins) {
    if (bin.count === 0) continue;
    lines.push(
      `  ${`${percent(bin.lower)}–${percent(bin.upper)}`.padEnd(14)}${String(bin.count).padStart(6)}` +
        `${percent(bin.predicted).padStart(11)}${percent(bin.observed).padStart(10)}`,
    );
  }

  return lines.join("\n");
}
