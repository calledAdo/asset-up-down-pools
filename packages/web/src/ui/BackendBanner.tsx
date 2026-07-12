//! A slim banner shown when the watcher backend is unreachable, so empty pages
//! read as "backend down" rather than "no data". Silent when healthy.

import { useHealth } from "../api/hooks.js";
import { WATCHER_API_URL } from "../config.js";

export function BackendBanner() {
  const { isError, isLoading, data } = useHealth();
  if (isLoading || (!isError && data?.ok)) return null;
  return (
    <div className="banner banner-warn">
      Can’t reach the backend at <code>{WATCHER_API_URL}</code> — start the watcher (indexer role)
      or set <code>VITE_WATCHER_API_URL</code>. Listings and actions will be empty until it’s up.
    </div>
  );
}
