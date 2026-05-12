export default function ScoreDistributionTable({ distribution, title = "Score Range" }) {
  if (!distribution?.ok) return null;
  const rows = Array.isArray(distribution.buckets) ? distribution.buckets : [];
  const { summary, threshold } = distribution;
  const below = summary?.below;

  return (
    <div className="analysis-dist-wrap">
      {below && (
        <div className="analysis-dist-summary">
          <div className="dist-summary-item below">
            <span className="label">Total Failure (&lt; {threshold}):</span>
            <span className="value">
              {below.count.toLocaleString()} ({below.pct})
            </span>
          </div>
        </div>
      )}

      <table className="analysis-dist-table" role="grid" aria-label="Distribution table">
        <thead>
          <tr>
            <th className="dist-th-range">{title}</th>
            <th className="dist-th-count">Count</th>
            <th className="dist-th-pct">Percentage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.range} className={b.isBelowThreshold ? "below-threshold" : ""}>
              <td className="dist-td-range">{b.range}</td>
              <td>{b.count.toLocaleString()}</td>
              <td>{b.pct}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

