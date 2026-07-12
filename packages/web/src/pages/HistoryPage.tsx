//! History: finalized and voided rounds, newest first, with their result.

import { Link } from "react-router-dom";

import { useHistory } from "../api/hooks.js";
import { EmptyState, ErrorState, Skeleton } from "../ui/states.js";
import { fmtCkb, fmtTime, shortId } from "../format.js";

export function HistoryPage() {
  const { data: pools, isLoading, error } = useHistory();

  if (isLoading) return <Skeleton rows={5} variant="row" />;
  if (error) return <ErrorState error={error} what="history" />;
  if (!pools?.length) return <EmptyState title="No settled rounds yet" hint="Finalized and voided rounds land here once they close." />;

  return (
    <>
      <div className="page-intro">
        <p className="eyebrow">Settled</p>
        <h1 className="page-title">History</h1>
      </div>
      <div className="panel">
        <table className="table">
          <thead>
            <tr><th>Lane</th><th>Result</th><th>Pool</th><th>Locked</th><th></th></tr>
          </thead>
          <tbody>
            {pools.map((p) => (
              <tr key={p.poolId}>
                <td>{p.lane.label}</td>
                <td>
                  <span className={`pill ${p.winner === "void" ? "void" : p.winner}`}>
                    {p.winner === "void" ? "VOID" : p.winner.toUpperCase()}
                  </span>
                </td>
                <td className="num">{fmtCkb(p.odds.total)} CKB</td>
                <td className="num">{fmtTime(p.closeTime)}</td>
                <td><Link className="btn small" to={`/pools/${p.poolId}`}>{shortId(p.poolId)}</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
