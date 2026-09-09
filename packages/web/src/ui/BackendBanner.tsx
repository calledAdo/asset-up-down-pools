//! Shown only when the backend is unreachable, so an empty page reads as
//! "the backend is down" rather than "there's nothing on".

import { useHealth } from "../api/hooks.js";
import { WATCHER_API_URL } from "../config.js";

export function BackendBanner() {
  const { isError, isLoading, data } = useHealth();
  if (isLoading || (!isError && data?.ok)) return null;
  return (
    <div className="note note-void" role="status" style={{ marginBottom: "var(--s-5)" }}>
      <strong>Can’t reach the backend.</strong> Nothing will load until{" "}
      <code>{WATCHER_API_URL}</code> answers. This isn’t an empty board — it’s a board with no
      data behind it.
    </div>
  );
}
