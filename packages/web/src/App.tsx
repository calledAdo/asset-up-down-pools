import { Suspense, lazy } from "react";
import { NavLink, Route, Routes } from "react-router-dom";

import { ConnectButton } from "./ui/ConnectButton.js";
import { ThemeSwitcher } from "./ui/ThemeSwitcher.js";
import { Brand } from "./ui/Brand.js";
import { BackendBanner } from "./ui/BackendBanner.js";
import { Skeleton } from "./ui/states.js";
import { NETWORK } from "./config.js";

// Route-level code splitting: each page is its own chunk.
const LanesPage = lazy(() => import("./pages/LanesPage.js").then((m) => ({ default: m.LanesPage })));
const PoolDetailPage = lazy(() => import("./pages/PoolDetailPage.js").then((m) => ({ default: m.PoolDetailPage })));
const PositionsPage = lazy(() => import("./pages/PositionsPage.js").then((m) => ({ default: m.PositionsPage })));
const HistoryPage = lazy(() => import("./pages/HistoryPage.js").then((m) => ({ default: m.HistoryPage })));

export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Brand />
          <span className="net">{NETWORK}</span>
        </div>
        <nav className="nav">
          <NavLink to="/" end>Markets</NavLink>
          <NavLink to="/positions">Positions</NavLink>
          <NavLink to="/history">History</NavLink>
        </nav>
        <ThemeSwitcher />
        <ConnectButton />
      </header>

      <BackendBanner />

      <main className="content">
        <Suspense fallback={<Skeleton rows={3} />}>
          <Routes>
            <Route path="/" element={<LanesPage />} />
            <Route path="/pools/:poolId" element={<PoolDetailPage />} />
            <Route path="/positions" element={<PositionsPage />} />
            <Route path="/history" element={<HistoryPage />} />
          </Routes>
        </Suspense>
      </main>

      <footer className="footer">
        PARIMUTUEL BTC UP/DOWN ON CKB · READS FROM THE WATCHER · TXS BUILT SERVER-SIDE, SIGNED IN YOUR WALLET
      </footer>
    </div>
  );
}
