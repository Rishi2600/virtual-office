import { create } from "zustand";

/**
 * Per-browser preferences, kept in localStorage (nothing here is sensitive or
 * shared). Storage can be unavailable (private mode, blocked site data), so
 * every read and write tolerates failure and falls back to the defaults.
 */
export interface Prefs {
  /** Soft chime when someone joins you or messages you. Off by default (owner decision). */
  sounds: boolean;
  /** Desktop notifications for messages while the tab is in the background. */
  notifications: boolean;
  micDeviceId: string;
  camDeviceId: string;
  speakerDeviceId: string;
  /** The first-run intro has been dismissed. */
  introSeen: boolean;
}

const KEY = "lamports:prefs";
const DEFAULTS: Prefs = {
  sounds: false,
  notifications: false,
  micDeviceId: "",
  camDeviceId: "",
  speakerDeviceId: "",
  introSeen: false,
};

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export const usePrefs = create<Prefs & { setPref: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void }>((set, get) => ({
  ...load(),
  setPref: (k, v) => {
    set({ [k]: v } as Partial<Prefs>);
    try {
      const { setPref: _ignored, ...prefs } = get();
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* not persisted; still applies for this visit */
    }
  },
}));
