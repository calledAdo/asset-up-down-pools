//! Promotional banner carousel — the top hero slot (à la SportsPredict's home).
//! Holds promos like new market listings, events, or how-it-works, auto-advancing
//! with dots + arrows. Slides are picture placeholders: each is a themed gradient
//! today; drop a real banner in via `image` and it renders as the background.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

interface Slide {
  eyebrow: string;
  title: string;
  subtitle: string;
  cta: string;
  to: string;
  theme: "a" | "b" | "c";
  image?: string; // when set, used as the banner background (else the gradient)
}

const SLIDES: Slide[] = [
  { eyebrow: "New market", title: "ETH/USD is live", subtitle: "Trade 5-minute and hourly ETH up/down rounds.", cta: "Trade ETH", to: "/", theme: "a" },
  { eyebrow: "This weekend", title: "Faster rounds, bigger pools", subtitle: "1-minute BTC markets, all weekend long.", cta: "See markets", to: "/", theme: "b" },
  { eyebrow: "New here?", title: "Pick UP or DOWN before the bell", subtitle: "Winners split the whole pot — your odds are the live pool split.", cta: "How it works", to: "/", theme: "c" },
];

const INTERVAL = 6000;

export function PromoSlider() {
  const [i, setI] = useState(0);
  const n = SLIDES.length;
  const go = (k: number) => setI(((k % n) + n) % n);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setI((p) => (p + 1) % n), INTERVAL);
    return () => clearInterval(id);
  }, [n]);

  return (
    <section className="promo" aria-roledescription="carousel" aria-label="Promotions">
      <div className="promo-track" style={{ transform: `translateX(-${i * 100}%)` }}>
        {SLIDES.map((s, idx) => (
          <div
            key={idx}
            className={`promo-slide promo-${s.theme}`}
            style={s.image ? { backgroundImage: `url(${s.image})` } : undefined}
            aria-hidden={idx !== i}
          >
            <div className="promo-copy">
              <span className="promo-eyebrow">{s.eyebrow}</span>
              <h2 className="promo-title">{s.title}</h2>
              <p className="promo-sub">{s.subtitle}</p>
              <Link className="btn promo-cta" to={s.to} tabIndex={idx === i ? 0 : -1}>{s.cta}</Link>
            </div>
            {!s.image && <span className="promo-imgtag">Banner image</span>}
          </div>
        ))}
      </div>

      <button className="promo-arrow left" aria-label="Previous promotion" onClick={() => go(i - 1)}>‹</button>
      <button className="promo-arrow right" aria-label="Next promotion" onClick={() => go(i + 1)}>›</button>
      <div className="promo-dots">
        {SLIDES.map((_, idx) => (
          <button key={idx} className={`promo-dot${idx === i ? " on" : ""}`} aria-label={`Go to promotion ${idx + 1}`} aria-current={idx === i} onClick={() => go(idx)} />
        ))}
      </div>
    </section>
  );
}
