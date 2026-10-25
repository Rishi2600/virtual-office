import type { PlayerView } from "../store.js";

/**
 * One description of what someone is doing, used everywhere they appear
 * (people panel, map name pill, huddle tile), so the UI never disagrees with
 * itself. Ordered by what matters most to someone deciding whether to walk over.
 */
export type PresenceKind = "offline" | "focus" | "private" | "talking" | "in-call" | "available";

export interface Presence {
  kind: PresenceKind;
  /** Short status line, e.g. "Focus mode". */
  text: string;
  /** Colour of the status dot. */
  dot: "ok" | "warn" | "off" | "accent";
  muted: boolean;
  speaking: boolean;
  video: boolean;
  sharing: boolean;
}

export function describe(
  p: PlayerView,
  opts: { speaking: boolean; inMyCall: boolean },
): Presence {
  const base = { muted: !p.micOn, speaking: opts.speaking && p.connected, video: p.camOn, sharing: p.sharing };
  if (!p.connected) return { ...base, kind: "offline", text: "Reconnecting…", dot: "off" };
  if (p.status === "focus") return { ...base, kind: "focus", text: "Focus mode", dot: "warn" };
  if (p.lockGroup) return { ...base, kind: "private", text: "Private conversation", dot: "warn" };
  if (opts.speaking) return { ...base, kind: "talking", text: p.sharing ? "Sharing screen" : "Talking", dot: "ok" };
  if (opts.inMyCall || p.isSelf) {
    const text = p.sharing ? "Sharing screen" : !p.micOn ? "Muted" : opts.inMyCall ? "In your huddle" : "Available";
    return { ...base, kind: opts.inMyCall ? "in-call" : "available", text, dot: "ok" };
  }
  return { ...base, kind: "available", text: p.sharing ? "Sharing screen" : "Available", dot: "ok" };
}
