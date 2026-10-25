/**
 * An avatar "look": which body parts someone's character is built from. It
 * travels as a short string ("skin.hairStyle.hairColor.top.bottom.extra", e.g.
 * "1.1.1.0.0.2") in the room state and is drawn by the client from code
 * (client/src/game/avatarArt.ts); there are no avatar image files.
 *
 * The server validates every look before it reaches anyone (people choose
 * their own in the avatar builder), so clients can trust what they receive.
 */
export interface AvatarLook {
  skin: number;
  hairStyle: number;
  hairColor: number;
  top: number;
  bottom: number;
  extra: number;
}

/** How many options each part has. The client's palettes must match. */
export const AVATAR_PARTS = {
  skin: 5,
  hairStyle: 5,
  hairColor: 6,
  top: 7,
  bottom: 4,
  extra: 4,
} as const satisfies Record<keyof AvatarLook, number>;

const ORDER: Array<keyof AvatarLook> = ["skin", "hairStyle", "hairColor", "top", "bottom", "extra"];

export function encodeLook(look: AvatarLook): string {
  return ORDER.map((k) => look[k]).join(".");
}

/** Parses and validates a look; null if it isn't exactly six in-range numbers. */
export function parseLook(value: unknown): AvatarLook | null {
  if (typeof value !== "string" || value.length > 32) return null;
  const parts = value.split(".");
  if (parts.length !== ORDER.length) return null;
  const look = {} as AvatarLook;
  for (let i = 0; i < ORDER.length; i++) {
    const key = ORDER[i]!;
    const raw = parts[i]!;
    if (!/^\d{1,2}$/.test(raw)) return null;
    const n = Number(raw);
    if (n >= AVATAR_PARTS[key]) return null;
    look[key] = n;
  }
  return look;
}

/** A stable, varied default for someone who hasn't built an avatar yet. */
export function defaultLook(seed: string): AvatarLook {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  const pick = (n: number) => {
    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
    return h % n;
  };
  return {
    skin: pick(AVATAR_PARTS.skin),
    hairStyle: pick(AVATAR_PARTS.hairStyle),
    hairColor: pick(AVATAR_PARTS.hairColor),
    top: pick(AVATAR_PARTS.top),
    bottom: pick(AVATAR_PARTS.bottom),
    extra: pick(AVATAR_PARTS.extra - 1), // none, glasses or headphones; the cap is opt-in
  };
}

/** The look to show: a valid chosen one, else the seeded default. */
export function resolveLook(chosen: unknown, seed: string): string {
  return encodeLook(parseLook(chosen) ?? defaultLook(seed));
}
