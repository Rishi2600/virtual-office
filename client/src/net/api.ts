import type { AppConfig, Me } from "../store.js";

/**
 * Per-tab identity for local testing.
 *
 * Cookies are shared between tabs of the same origin, so two tabs would always
 * be the same person. When a tab signs in through the dev route we also stash
 * the session token in sessionStorage, which IS per-tab — that's what lets you
 * run Alice and Bob side by side in one browser.
 *
 * Only ever populated by the dev sign-in route, which is disabled in production.
 */
const TOKEN_KEY = "vo_dev_session";

function readDevToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // private mode / storage blocked
  }
}

function writeDevToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* fall back to the cookie */
  }
}

export function clearDevToken(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const token = readDevToken();
  return token ? { ...extra, authorization: `Bearer ${token}` } : { ...extra };
}

const request = (path: string, init: RequestInit = {}) =>
  fetch(path, { ...init, credentials: "same-origin", headers: authHeaders(init.headers) });

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Null when not signed in — the app renders the login screen instead. */
export async function fetchMe(): Promise<Me | null> {
  const res = await request("/api/me");
  if (res.status === 401) return null;
  return json<Me>(res);
}

export function fetchConfig(): Promise<AppConfig> {
  return request("/api/config").then(json<AppConfig>);
}

/** Local-only shortcut so you can be two different people in two tabs. */
export async function devSignIn(name: string): Promise<Me> {
  const res = await request("/auth/dev", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const user = await json<Me & { token?: string }>(res);
  if (user.token) writeDevToken(user.token);
  return user;
}

/**
 * Supports `?dev=Bob` so a second tab can be a second person in one step.
 * Returns true if it signed in, in which case the caller should re-fetch `me`.
 */
export async function applyDevIdentityFromUrl(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  const name = params.get("dev");
  if (!name) return false;

  // Strip the parameter so a refresh doesn't re-sign-in and the name isn't
  // sitting in the address bar for the rest of the session.
  params.delete("dev");
  const query = params.toString();
  history.replaceState(null, "", location.pathname + (query ? `?${query}` : ""));

  try {
    await devSignIn(name);
    return true;
  } catch {
    return false;
  }
}

export async function logout(): Promise<void> {
  await request("/auth/logout", { method: "POST" });
  clearDevToken();
}

/**
 * Short-lived token for the WebSocket handshake. Fetched fresh on every connect
 * and every reconnect, because it expires in a couple of minutes by design.
 */
export async function fetchRealtimeToken(): Promise<string> {
  const { token } = await request("/api/rt-token").then(json<{ token: string }>);
  return token;
}
