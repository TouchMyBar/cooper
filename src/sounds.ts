import { api } from "./store";
import { BUILTIN } from "./sounds-builtin";
import type { SoundPref, SoundPrefs } from "./types";

export const BUILTIN_CHOICES: { id: string; label: string }[] = [
  { id: "pop", label: "Pop" },
  { id: "click", label: "Click" },
  { id: "morse", label: "Morse" },
  { id: "none", label: "None" },
  { id: "custom", label: "Custom…" },
];

let prefs: SoundPrefs | null = null;
let audio: HTMLAudioElement | null = null;

function element(): HTMLAudioElement {
  if (!audio) audio = new Audio();
  return audio;
}

export async function loadSoundPrefs(): Promise<void> {
  try {
    prefs = await api.getSoundPrefs();
  } catch {
    /* keep whatever we had */
  }
}
export const reloadSoundPrefs = loadSoundPrefs;

/** Resolve a preference to a playable URL (or null for "none"/missing custom). */
export function resolveUrl(pref: SoundPref | undefined): string | null {
  if (!pref || pref.choice === "none") return null;
  if (pref.choice === "custom") return pref.custom || null;
  return BUILTIN[pref.choice] ?? null;
}

function playUrl(url: string | null, volume: number) {
  if (!url) return;
  const a = element();
  a.src = url;
  a.volume = Math.max(0, Math.min(1, volume));
  a.currentTime = 0;
  a.play().catch(() => {
    /* autoplay/codec failure — stay silent */
  });
}

/** Play the configured sound for an event. No-op until prefs are loaded. */
export function play(event: "capture" | "newNote"): void {
  if (!prefs) return;
  const pref = event === "capture" ? prefs.capture : prefs.newNote;
  playUrl(resolveUrl(pref), prefs.volume ?? 0.6);
}

/** Preview an explicit URL from the Settings sheet. */
export function preview(url: string | null, volume = 0.6): void {
  playUrl(url, volume);
}
