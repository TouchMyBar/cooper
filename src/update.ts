import { api } from "./store";
import type { AppState, UpdateInfo } from "./types";

const RELEASES_API = "https://api.github.com/repos/TouchMyBar/cooper/releases/latest";

/** Local calendar date as YYYY-MM-DD, for the once-per-day gate. */
export function todayLocal(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** True only if `latestTag` is a strictly higher semver than `current`. Any
 *  unparseable / pre-release tag fails safe to false so a bad release never
 *  spams the banner. */
export function isNewer(latestTag: string, current: string): boolean {
  const parse = (s: string): number[] | null => {
    const core = String(s).trim().replace(/^v/i, "").split("-")[0].split("+")[0];
    const parts = core.split(".").map((x) => parseInt(x, 10));
    if (!parts.length || parts.some((n) => Number.isNaN(n))) return null;
    return parts;
  };
  const a = parse(latestTag);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Once per calendar day (when enabled), ask GitHub for the latest release and
 *  report it if it's newer than the running build. Records the check date BEFORE
 *  the network call so an offline failure still counts and we never hammer the API. */
export async function runUpdateCheck(
  state: AppState,
  onFound: (u: UpdateInfo) => void,
): Promise<void> {
  if (!state.updateCheckEnabled) return;
  const today = todayLocal();
  if (state.lastUpdateCheck === today) return;
  try {
    await api.setUpdateLastCheck(today);
  } catch {
    /* ignore persistence failure */
  }
  try {
    const r = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!r.ok) return;
    const j = await r.json();
    if (j?.tag_name && isNewer(j.tag_name, state.appVersion)) {
      onFound({ tag: j.tag_name, url: j.html_url });
    }
  } catch {
    /* offline: silent */
  }
}
