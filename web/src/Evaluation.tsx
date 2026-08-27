import { useEffect, useState } from "react";
import { api, type CohortResult, type EvaluationReport, percent, rupees } from "./api";

export function Evaluation() {
  const [report, setReport] = useState<EvaluationReport>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api
      .evaluation()
      .then(setReport)
      .catch((cause: Error) => setError(cause.message));
  }, []);

  if (error) return <p className="placeholder">{error}</p>;
  if (!report) return <p className="placeholder">Scoring every alert…</p>;

  const c = report.casefile;
  const e2e = report.endToEnd;

  return (
    <div className="page">
      <p className="note">
        Measured on the <b>{report.world}</b> world: {report.totalTransactions.toLocaleString()}{" "}
        transactions, of which the upstream rules engine flags {report.alerts.toLocaleString()} (
        {percent(report.alertRate)}). Precision and recall below describe triage of that queue.
      </p>

      <div className="grid">
        <Stat label="Precision" value={c.precision.toFixed(3)} note="of payments blocked, share that were fraud" />
        <Stat label="Recall" value={c.recall.toFixed(3)} note="of fraud in the queue, share blocked" />
        <Stat label="F1" value={c.f1.toFixed(3)} note={`PR-AUC ${report.prAuc.toFixed(3)}`} />
        <Stat
          label="False positive rate"
          value={percent(c.falsePositiveRate)}
          note={`${c.falsePositives} legitimate payments blocked`}
        />
      </div>

      <section className="section" style={{ marginTop: 24 }}>
        <h2>End to end — including fraud the alerting layer never surfaces</h2>
        <p className="note">
          The figures above are computed over the alert queue, so fraud the rules engine misses is
          invisible to them. Of <b>{e2e.fraudInWorld}</b> fraudulent transactions in this world,{" "}
          <b>{e2e.fraudReachingQueue}</b> ({percent(e2e.alertingRecall)}) reach triage at all, and{" "}
          <b className="highlight">{e2e.fraudBlocked} ({percent(e2e.endToEndBlockRate)})</b> are
          blocked end to end.
        </p>
        <table>
          <thead>
            <tr>
              <th>Mechanism</th>
              <th className="num">Fraud</th>
              <th className="num">Reaches queue</th>
              <th className="num">Blocked</th>
              <th style={{ width: 120 }} />
            </tr>
          </thead>
          <tbody>
            {e2e.invisibleToAlerting.map((cohort) => (
              <tr key={cohort.name}>
                <td className="name">{cohort.name}</td>
                <td className="num">{cohort.count}</td>
                <td className="num">{percent(cohort.catchRate, 0)}</td>
                <td className="num">{percent(cohort.blockRate, 0)}</td>
                <td>
                  <Bar value={cohort.blockRate} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="section">
        <h2>Baselines</h2>
        <p className="note">
          If a naive rule scored well here, none of the other numbers would mean anything.
        </p>
        <table>
          <thead>
            <tr>
              <th>Strategy</th>
              <th className="num">Precision</th>
              <th className="num">Recall</th>
              <th className="num">F1</th>
              <th className="num">Realised cost</th>
            </tr>
          </thead>
          <tbody>
            {report.baselines.map((baseline) => (
              <tr key={baseline.name}>
                <td className="name">
                  {baseline.name}
                  <div style={{ color: "var(--dim)", fontSize: 12 }}>{baseline.description}</div>
                </td>
                <td className="num">{baseline.metrics.precision.toFixed(3)}</td>
                <td className="num">{baseline.metrics.recall.toFixed(3)}</td>
                <td className="num">{baseline.metrics.f1.toFixed(3)}</td>
                <td className="num">{rupees(baseline.costMinor)}</td>
              </tr>
            ))}
            <tr style={{ background: "var(--panel-raised)" }}>
              <td className="name">
                <b>casefile</b>
              </td>
              <td className="num">{c.precision.toFixed(3)}</td>
              <td className="num">{c.recall.toFixed(3)}</td>
              <td className="num">{c.f1.toFixed(3)}</td>
              <td className="num">{rupees(report.costs.casefileMinor)}</td>
            </tr>
          </tbody>
        </table>
        <p className="note" style={{ marginTop: 12 }}>
          Sending every alert to an analyst costs {rupees(report.costs.rulesOnlyMinor)}. Triage costs{" "}
          {rupees(report.costs.casefileMinor)} — a saving of{" "}
          <b>{rupees(report.costs.savedVsRulesMinor)}</b> (
          {percent(report.costs.savedVsRulesMinor / report.costs.rulesOnlyMinor)}), with{" "}
          {percent(report.autoDecisionRate)} of alerts resolved without a human and{" "}
          {report.analystHoursSaved.toFixed(0)} analyst hours returned.
        </p>
      </section>

      <CohortTable
        title="By fraud mechanism"
        note="Blocked outright versus not let through. Both are successes for a triage system; clearing fraud is the failure."
        rows={report.perVariant}
      />

      <CohortTable
        title="Hard negatives — legitimate behaviour engineered to look like fraud"
        note="These are the false positives that matter. Lower is better."
        rows={report.decoyCohorts.filter((cohort) => cohort.count >= 3)}
        warn
      />

      <section className="section">
        <h2>Calibration</h2>
        <p className="note">
          A verdict of "72% likely fraud" is only useful if roughly 72% of such cases are fraud.
          Brier score {report.calibration.brier.toFixed(4)}, expected calibration error{" "}
          {report.calibration.expectedCalibrationError.toFixed(4)}.
        </p>
        <table>
          <thead>
            <tr>
              <th>Predicted band</th>
              <th className="num">Cases</th>
              <th className="num">Mean predicted</th>
              <th className="num">Actually fraud</th>
              <th style={{ width: 160 }} />
            </tr>
          </thead>
          <tbody>
            {report.calibration.bins
              .filter((bin) => bin.count > 0)
              .map((bin) => (
                <tr key={bin.lower}>
                  <td>
                    {percent(bin.lower, 0)}–{percent(bin.upper, 0)}
                  </td>
                  <td className="num">{bin.count}</td>
                  <td className="num">{percent(bin.predicted)}</td>
                  <td className="num">{percent(bin.observed)}</td>
                  <td>
                    <Bar value={bin.observed} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="card">
      <h3>{label}</h3>
      <div className="big">{value}</div>
      <small>{note}</small>
    </div>
  );
}

function Bar({ value, warn }: { value: number; warn?: boolean }) {
  return (
    <div className={`bar${warn ? " warn" : ""}`}>
      <i style={{ width: `${Math.min(100, value * 100)}%` }} />
    </div>
  );
}

function CohortTable({
  title,
  note,
  rows,
  warn,
}: {
  title: string;
  note: string;
  rows: CohortResult[];
  warn?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="section">
      <h2>{title}</h2>
      <p className="note">{note}</p>
      <table>
        <thead>
          <tr>
            <th>Cohort</th>
            <th className="num">Cases</th>
            <th className="num">Blocked</th>
            <th className="num">Not cleared</th>
            <th style={{ width: 140 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map((cohort) => (
            <tr key={cohort.name}>
              <td className="name">{cohort.name}</td>
              <td className="num">{cohort.count}</td>
              <td className="num">{percent(cohort.blockRate, 0)}</td>
              <td className="num">{percent(cohort.catchRate, 0)}</td>
              <td>
                <Bar value={cohort.blockRate} warn={warn} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
