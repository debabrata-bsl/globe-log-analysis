import { useCallback, useMemo, useState } from "react";
import { parseCSV } from "../csvUtils.js";
import { analyzeMsisdnExportCsv, EKYC_FLOW_APIS } from "../msisdnLogAnalysis.js";
import "../styles/ErrorReport.css";

function statusLabel(status) {
  if (status === "ok") return "OK";
  if (status === "error") return "Error";
  return "No log lines";
}

function statusClass(status) {
  if (status === "ok") return "msisdn-pill msisdn-pill-ok";
  if (status === "error") return "msisdn-pill msisdn-pill-err";
  return "msisdn-pill msisdn-pill-muted";
}

export default function MsisdnReport() {
  const [fileName, setFileName] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [parseError, setParseError] = useState(null);

  const onFile = useCallback((ev) => {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    if (!f) return;
    setFileName(f.name);
    setParseError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result ?? "");
        const matrix = parseCSV(text);
        const result = analyzeMsisdnExportCsv(matrix);
        if (!result.ok) {
          setAnalysis(null);
          setParseError(result.error || "Could not analyze file.");
          return;
        }
        setAnalysis(result);
        setParseError(null);
      } catch (e) {
        setAnalysis(null);
        setParseError(e?.message || "Failed to read CSV.");
      }
    };
    reader.onerror = () => {
      setAnalysis(null);
      setParseError("Could not read file.");
    };
    reader.readAsText(f, "UTF-8");
  }, []);

  const summaryLines = useMemo(() => {
    if (!analysis?.ok) return [];
    const lines = [];
    if (analysis.msisdns.length) {
      lines.push(`MSISDN in log: ${analysis.msisdns.join(", ")}`);
    } else {
      lines.push("No MSISDN token found in textPayload (expected pattern MSISDN: digits).");
    }
    lines.push(`Rows scanned: ${analysis.rowCount} · API-tagged events: ${analysis.events.length}`);
    if (analysis.firstErrorChronological) {
      const e = analysis.firstErrorChronological;
      lines.push(
        `Earliest error (time): ${e.method} ${e.apiPath}${e.http ? ` [${e.http}]` : ""} — row ${e.row}`
      );
    }
    if (analysis.firstFailureInFlow && analysis.firstErrorChronological) {
      const a = analysis.firstFailureInFlow;
      const b = analysis.firstErrorChronological;
      const same = a.row === b.row && a.apiPath === b.apiPath && a.ts === b.ts;
      if (!same) {
        lines.push(
          `First eKYC step with any error (flow order): ${a.method} ${a.apiPath}${a.http ? ` [${a.http}]` : ""}`
        );
      }
    }
    return lines;
  }, [analysis]);

  return (
    <div className="report-container">
      <div className="panel no-print">
        <h2 className="msisdn-module-title">Error Log Based on MSISDN</h2>
        <p className="msisdn-module-desc">
          Upload a GCP log export CSV (with a <code>textPayload</code> column). The tool scans these
          eKYC BFF routes and marks where <strong>API ERROR</strong>, non-2xx, <strong>Status: FAILED</strong>,
          or <strong>ERROR</strong> stack lines reference each path.
        </p>
        <div className="panel-row">
          <label className="file-pick">
            <span>Upload log CSV</span>
            <input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} />
          </label>
          {fileName ? <span className="msisdn-filename">{fileName}</span> : null}
        </div>
        <p className="msisdn-api-list no-print">
          Tracked APIs ({EKYC_FLOW_APIS.length}):{" "}
          {EKYC_FLOW_APIS.map((a) => (
            <code key={a.path} className="msisdn-code">
              {a.method} {a.path}
            </code>
          ))}
        </p>
      </div>

      {parseError ? (
        <div className="no-data" role="alert">
          {parseError}
        </div>
      ) : null}

      {analysis?.ok ? (
        <>
          <div className="panel msisdn-summary-panel">
            <h3 className="msisdn-h3">Summary</h3>
            <ul className="msisdn-summary-list">
              {summaryLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          <div id="wrap">
            <table className="data-table" role="grid" aria-label="eKYC API error summary by MSISDN log">
              <thead>
                <tr>
                  <th style={{ width: "6rem" }}>Status</th>
                  <th style={{ width: "5rem" }}>Method</th>
                  <th>API path</th>
                  <th style={{ width: "5rem" }}>HTTP</th>
                  <th>Errors</th>
                  <th>Excerpt (last error, or last event)</th>
                </tr>
              </thead>
              <tbody>
                {analysis.byApi.map((row) => (
                  <tr key={row.path}>
                    <td>
                      <span className={statusClass(row.status)}>{statusLabel(row.status)}</span>
                    </td>
                    <td>
                      <div className="cell">{row.method}</div>
                    </td>
                    <td>
                      <div className="cell cell-mono">{row.path}</div>
                    </td>
                    <td>
                      <div className="cell">
                        {row.lastHttp || "—"}
                        {row.recovered ? (
                          <span className="msisdn-recovered" title="A later call to this API returned success">
                            {" "}
                            → OK after
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <div className="cell">
                        {row.errorCount}
                        {row.successCount ? ` · ${row.successCount} OK` : ""}
                      </div>
                    </td>
                    <td>
                      <div className="cell cell-small">{row.lastExcerpt || "—"}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {analysis.byApi.some((r) => r.samples.length > 0) ? (
            <div className="panel" style={{ marginTop: "1.25rem" }}>
              <h3 className="msisdn-h3">Error samples (up to 5 per API)</h3>
              <div id="wrap" style={{ marginTop: "0.75rem" }}>
                <table className="data-table" role="grid" aria-label="Sample error lines">
                  <thead>
                    <tr>
                      <th>API</th>
                      <th style={{ width: "4rem" }}>Row</th>
                      <th>Excerpt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.byApi.flatMap((r) =>
                      r.samples.map((s, i) => (
                        <tr key={`${r.path}-${s.insertId}-${i}`}>
                          <td>
                            <div className="cell cell-mono">{r.path}</div>
                          </td>
                          <td>
                            <div className="cell">{s.row}</div>
                          </td>
                          <td>
                            <div className="cell cell-small">{s.excerpt}</div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </>
      ) : !parseError ? (
        <div className="no-data">Upload a log CSV to see the error report.</div>
       ) : null}
     </div>
   );
 }
