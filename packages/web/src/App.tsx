import { Suspense, lazy } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";

import { ConnectButton } from "./ui/ConnectButton.js";
import { BackendBanner } from "./ui/BackendBanner.js";
import { Mark } from "./ui/glyphs.js";
import { BRAND, NETWORK } from "./config.js";
import css from "./App.module.css";

const RoundsPage = lazy(() => import("./pages/RoundsPage.js").then((m) => ({ default: m.RoundsPage })));
const RoundPage = lazy(() => import("./pages/RoundPage.js").then((m) => ({ default: m.RoundPage })));

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? css.on : undefined);

export function App() {
  return (
    <div className={css.app}>
      <a className={css.skip} href="#main">Skip to the board</a>

      <header className={css.bar}>
        <NavLink to="/" className={css.mark} aria-label={`${BRAND} — home`}>
          <Mark />
          <span className={css.word}>{BRAND}</span>
        </NavLink>

        <nav className={css.nav} aria-label="Main">
          <NavLink to="/" end className={navClass}>The board</NavLink>
          <NavLink to="/stakes" className={navClass}>Your bets</NavLink>
          <NavLink to="/results" className={navClass}>Results</NavLink>
        </nav>

        <div className={css.right}>
          <span className={css.net}>{NETWORK}</span>
          <ConnectButton />
        </div>
      </header>

      <main id="main" className={css.main}>
        <BackendBanner />
        <Suspense fallback={<div className="skeleton skeleton-card" />}>
          <Routes>
            <Route path="/" element={<RoundsPage />} />
            <Route path="/rounds/:poolId" element={<RoundPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>

      <footer className={css.foot}>
        There's no house here — you win the other side's money. Your stake is yours until the
        round locks.
      </footer>
    </div>
  );
}
