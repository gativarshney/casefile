import { useEffect, useState } from "react";
import { type AlertSummary, api, formatTime, type Overview, percent, rupees } from "./api";
import { CaseView } from "./CaseView";
import { Evaluation } from "./Evaluation";

type Tab = "queue" | "evaluation";

export function App() {
  const [tab, setTab] = useState<Tab>("queue");
  const [overview, setOverview] = useState<Overview>();
  const [alerts, setAlerts] = useState<AlertSummary[]>([]);
  const [selected, setSelected] = useState<string>();

  useEffect(() => {
    api.overview().then(setOverview).catch(() => undefined);
    api
      .alerts()
      .then((rows) => {
        setAlerts(rows);
        setSelected((current) => current ?? rows[0]?.alertId);
      })
      .catch(() => undefined);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Casefile
          <span>
            {overview
              ? `${overview.alerts.toLocaleString()} alerts · ${percent(overview.alertRate)} of ${overview.transactions.toLocaleString()} payments`
              : "loading…"}
          </span>
        </div>
        <nav className="tabs">
          <button
            type="button"
            className="tab"
            aria-selected={tab === "queue"}
            onClick={() => setTab("queue")}
          >
            Alert queue
          </button>
          <button
            type="button"
            className="tab"
            aria-selected={tab === "evaluation"}
            onClick={() => setTab("evaluation")}
          >
            Evaluation
          </button>
        </nav>
      </header>

      {tab === "evaluation" ? (
        <Evaluation />
      ) : (
        <div className="queue-layout">
          <aside className="queue">
            <div className="queue-header">Raised by the rules engine</div>
            {alerts.map((alert) => (
              <button
                type="button"
                key={alert.alertId}
                className="alert-row"
                aria-current={alert.alertId === selected}
                onClick={() => setSelected(alert.alertId)}
              >
                <div className="alert-rule">{alert.ruleId.replace("rule.", "")}</div>
                <div className="alert-meta">
                  <span className="alert-amount">{rupees(alert.amountMinor)}</span>
                  <span className="alert-time">{formatTime(alert.atMs)}</span>
                </div>
              </button>
            ))}
          </aside>
          <main className="detail">
            {selected ? <CaseView alertId={selected} /> : <p className="placeholder">No alerts.</p>}
          </main>
        </div>
      )}
    </div>
  );
}
