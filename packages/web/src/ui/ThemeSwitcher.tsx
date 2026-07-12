//! Live theme switcher. Each theme is just a `data-theme` value on <html> that
//! flips the token block in styles.css; we persist the choice to localStorage.
//! The initial value is set by a tiny inline script in index.html (no flash).

import { useState } from "react";

type ThemeId = "daylight" | "ocean";

const THEMES: { id: ThemeId; label: string; c1: string; c2: string }[] = [
  { id: "daylight", label: "Daylight", c1: "#2f6bff", c2: "#16a957" },
  { id: "ocean", label: "Deep Ocean", c1: "#4d8dff", c2: "#2dd4bf" },
];

function current(): ThemeId {
  const t = document.documentElement.dataset.theme;
  return t === "daylight" ? t : "ocean";
}

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeId>(current);

  const pick = (id: ThemeId) => {
    document.documentElement.dataset.theme = id;
    try { localStorage.setItem("theme", id); } catch { /* private mode */ }
    setTheme(id);
  };

  return (
    <div className="theme-switch" role="group" aria-label="Colour theme">
      {THEMES.map((t) => (
        <button
          key={t.id}
          className={`swatch${theme === t.id ? " active" : ""}`}
          title={t.label}
          aria-label={t.label}
          aria-pressed={theme === t.id}
          onClick={() => pick(t.id)}
          style={{ background: `linear-gradient(135deg, ${t.c1} 0 50%, ${t.c2} 50% 100%)` }}
        />
      ))}
    </div>
  );
}
