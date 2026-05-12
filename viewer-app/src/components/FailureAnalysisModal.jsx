import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import ScoreDistributionTable from "./ScoreDistributionTable.jsx";

export default function FailureAnalysisModal({
  open,
  onClose,
  failureAnalysis,
  scoreDistribution,
  ageDistribution,
} = {}) {
  const [tab, setTab] = useState("overview"); // overview | score | age
  const overviewItems = Array.isArray(failureAnalysis?.items) ? failureAnalysis.items : [];
  useEffect(() => {
    if (open) {
      document.body.classList.add("modal-open");
    } else {
      document.body.classList.remove("modal-open");
    }
    return () => document.body.classList.remove("modal-open");
  }, [open]);

  if (!open || !failureAnalysis) return null;

  return createPortal(
    <div className="analysis-modal-overlay no-print" onClick={onClose}>
      <div className="analysis-modal" onClick={(e) => e.stopPropagation()}>
        <div className="analysis-modal-header">
          <div className="analysis-header-left">
            <h2>Failure Analysis</h2>
            <span className="analysis-summary-pill">{failureAnalysis.total} rows</span>
          </div>
          <button className="analysis-modal-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="analysis-modal-tabs" role="tablist" aria-label="Failure analysis tabs">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "overview"}
            className={tab === "overview" ? "analysis-tab active" : "analysis-tab"}
            onClick={() => setTab("overview")}
          >
            Overview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "score"}
            className={tab === "score" ? "analysis-tab active" : "analysis-tab"}
            onClick={() => setTab("score")}
          >
            Score Distribution
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "age"}
            className={tab === "age" ? "analysis-tab active" : "analysis-tab"}
            onClick={() => setTab("age")}
          >
            Age Distribution
          </button>
        </div>

        <div className="analysis-body">
          {tab === "overview" && (
            <>
              {overviewItems[0] && (
                <p className="analysis-summary-top" style={{ marginTop: 0, marginBottom: "0.5rem" }}>
                  <strong>Top issue:</strong> {overviewItems[0].label} ({overviewItems[0].pct}
                  %)
                </p>
              )}
              <ul className="analysis-bars">
                {overviewItems.map((item) => (
                  <li key={item.key}>
                    <div className="analysis-row-head">
                      <span className="analysis-label">{item.label}</span>
                      <span className="analysis-pct">
                        {item.pct}% <span className="analysis-count">({item.count})</span>
                      </span>
                    </div>
                    <div className="analysis-track" role="presentation">
                      <div className="analysis-fill" style={{ width: `${Math.min(100, item.pct)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {tab === "score" && (
            <>
              {scoreDistribution?.ok ? (
                <ScoreDistributionTable distribution={scoreDistribution} />
              ) : (
                <div className="no-data" style={{ padding: "0.75rem 0" }}>
                  {scoreDistribution?.reason || "Score distribution unavailable."}
                </div>
              )}
            </>
          )}

          {tab === "age" && (
            <>
              {ageDistribution?.ok ? (
                <>
                  <ScoreDistributionTable distribution={ageDistribution} title="Age Range" />
                </>
              ) : (
                <div className="no-data" style={{ padding: "0.75rem 0" }}>
                  {ageDistribution?.reason || "Age distribution unavailable."}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
