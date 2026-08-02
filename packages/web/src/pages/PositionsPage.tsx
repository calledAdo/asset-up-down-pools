//! "My positions": the connected wallet's holdings across all pools, looked up by its
//! CKB address (the watcher resolves it to a lock script). Each row links to the pool
//! so the user can redeem or reclaim.

import { Link } from "react-router-dom";

import { usePositions } from "../api/hooks.js";
import { useWallet } from "../wallet/useWallet.js";
import { EmptyState, ErrorState, Skeleton } from "../ui/states.js";
import { fmtCkb, shortId } from "../format.js";

export function PositionsPage() {
  const { connected, address, open } = useWallet();
  const { data: positions, isLoading, error } = usePositions(address);

  if (!connected) {
    return (
      <EmptyState
        title="Connect a wallet"
        hint="Your UP and DOWN positions across every round show up here."
        action={<button className="btn btn-primary" onClick={open}>Connect wallet</button>}
      />
    );
  }
  if (isLoading) return <Skeleton rows={4} variant="row" />;
  if (error) return <ErrorState error={error} what="positions" />;
  if (!positions?.length) return <EmptyState title="No positions yet" hint="Stake on a market to get started." action={<Link className="btn btn-primary" to="/">Browse markets</Link>} />;

  return (
    <>
      <div className="page-intro">
        <p className="eyebrow">Wallet</p>
        <h1 className="page-title">Positions</h1>
      </div>
      <div className="panel">
        <table className="table">
          <thead>
            <tr><th>Round</th><th>Side</th><th>Staked</th><th></th></tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={`${p.outPoint.txHash}:${p.outPoint.index}`}>
                <td className="num" title={p.poolId}>{shortId(p.poolId)}</td>
                <td><span className={`pill ${p.side}`}>{p.side.toUpperCase()}</span></td>
                <td className="num">{fmtCkb(p.amount)} CKB</td>
                <td><Link className="btn small" to={`/pools/${p.poolId}`}>Open</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
