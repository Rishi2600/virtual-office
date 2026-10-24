import type { Browser, BrowserContext, Page } from "@playwright/test";

/** The parts of the dev-only globals (client/src/store.ts, client/src/ui/App.tsx)
 *  that the tests read. Kept minimal on purpose. */
interface DevPlayer { x: number; y: number; name: string }
interface DevPeer { polite: boolean; pc: RTCPeerConnection }

declare global {
  interface Window {
    __store?: {
      getState(): { connection: string; peers: Record<string, { connectionState: string }> };
    };
    __session?: {
      room: {
        sessionId: string;
        state: { players: { forEach(cb: (p: DevPlayer, id: string) => void): void } };
      } | null;
      peers: { peers: Map<string, DevPeer> } | null;
      disconnect(): Promise<void>;
    };
  }
}

export interface Person {
  name: string;
  context: BrowserContext;
  page: Page;
}

/** Signs a fresh person in through the dev route and waits until they're in the office. */
export async function join(browser: Browser, label: string): Promise<Person> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const name = `${label}-${Math.random().toString(36).slice(2, 7)}`;
  await page.goto(`/?dev=${encodeURIComponent(name)}`);
  await page.waitForFunction(() => window.__store?.getState().connection === "connected");
  return { name, context, page };
}

/** Consented leave, so the next test starts in an empty room rather than next
 *  to this person's 30-second reconnect ghost. */
export async function leave(...people: Person[]): Promise<void> {
  for (const p of people) {
    await p.page.evaluate(() => window.__session?.disconnect()).catch(() => {});
    await p.context.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Walks `a` towards `b` until the server pairs them. */
export async function walkIntoCall(a: Person, b: Person, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let preferX = true;
  let last = "";
  while (Date.now() < deadline) {
    const s = await a.page.evaluate((otherName) => {
      const room = window.__session?.room;
      let me: DevPlayer | null = null;
      let other: DevPlayer | null = null;
      room?.state.players.forEach((p, id) => {
        if (id === room.sessionId) me = p;
        else if (p.name === otherName) other = p;
      });
      const peers = Object.keys(window.__store?.getState().peers ?? {}).length;
      const m = me as DevPlayer | null;
      const o = other as DevPlayer | null;
      return { peers, dx: m && o ? o.x - m.x : 0, dy: m && o ? o.y - m.y : 0, at: m ? `${m.x},${m.y}` : "" };
    }, b.name);
    if (s.peers > 0) return;

    // Greedy steps along one axis; switch axes when something blocks us.
    if (s.at === last) preferX = !preferX;
    last = s.at;
    const useX = preferX ? Math.abs(s.dx) > 8 : Math.abs(s.dy) <= 8;
    const key = useX ? (s.dx > 0 ? "ArrowRight" : "ArrowLeft") : (s.dy > 0 ? "ArrowDown" : "ArrowUp");
    await a.page.keyboard.down(key);
    await sleep(90);
    await a.page.keyboard.up(key);
    await sleep(30);
  }
  throw new Error(`${a.name} never got into a call with ${b.name}`);
}

/** True once every peer connection on this page reports `connected`. */
export const allPeersConnected = (page: Page) =>
  page.evaluate(() => {
    const peers = Object.values(window.__store?.getState().peers ?? {});
    return peers.length > 0 && peers.every((p) => p.connectionState === "connected");
  });

/** Signaling state of every peer connection, e.g. ["stable"]. */
export const signalingStates = (page: Page) =>
  page.evaluate(() => [...(window.__session?.peers?.peers.values() ?? [])].map((p) => p.pc.signalingState));

/** Whether this page is the polite side of its (single) call. */
export const isPolite = (page: Page) =>
  page.evaluate(() => [...(window.__session?.peers?.peers.values() ?? [])][0]?.polite ?? null);

/**
 * Is any media element actually PLAYING a track received from a peer?
 * Matched against RTCRtpReceiver tracks rather than CSS classes, so it keeps
 * working however the UI renders remote media.
 */
export const playingRemote = (page: Page, kind: "audio" | "video") =>
  page.evaluate((k) => {
    const received = new Set<string>();
    for (const peer of window.__session?.peers?.peers.values() ?? []) {
      for (const r of peer.pc.getReceivers()) if (r.track.kind === k) received.add(r.track.id);
    }
    return [...document.querySelectorAll<HTMLMediaElement>("audio, video")].some((el) => {
      const stream = el.srcObject as MediaStream | null;
      const carries = !!stream?.getTracks().some((t) => t.kind === k && received.has(t.id) && t.readyState === "live");
      if (!carries || el.paused || el.readyState < 2) return false;
      return k === "audio" ? !el.muted : (el as HTMLVideoElement).videoWidth > 0;
    });
  }, kind);

/** Video frames decoded from peers over a short window — proves frames are still flowing. */
export async function framesDecodedDelta(page: Page, windowMs = 1500): Promise<number> {
  const read = () =>
    page.evaluate(async () => {
      let total = 0;
      for (const peer of window.__session?.peers?.peers.values() ?? []) {
        for (const s of (await peer.pc.getStats()).values()) {
          if (s.type === "inbound-rtp" && s.kind === "video") total += s.framesDecoded ?? 0;
        }
      }
      return total;
    });
  const before = await read();
  await sleep(windowMs);
  return (await read()) - before;
}
