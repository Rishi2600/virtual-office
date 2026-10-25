import { expect, test } from "@playwright/test";
import { allPeersConnected, join, leave, playingRemote, walkIntoCall, type Person } from "./helpers.js";

// Needs a real TURN server: CI starts coturn; locally `npm run turn:up` with
// TURN_URLS/TURN_SECRET in .env (see .env.example).
test.skip(!process.env.TURN_URLS, "no TURN server configured (TURN_URLS unset)");

/** Lets this page use ONLY relayed (TURN) routes, as on a network that blocks
 *  direct connections. Runs before any app code. */
function relayOnly(): void {
  const Real = window.RTCPeerConnection;
  class RelayOnly extends Real {
    constructor(config?: RTCConfiguration) {
      super({ ...config, iceTransportPolicy: "relay" });
    }
    setConfiguration(config?: RTCConfiguration): void {
      super.setConfiguration({ ...config, iceTransportPolicy: "relay" });
    }
  }
  window.RTCPeerConnection = RelayOnly;
}

/** relayOnly, plus a TURN credential the server didn't sign. Self-contained on
 *  purpose: init scripts are sent to the page as source text, so they can't
 *  call other functions from this file. */
function relayOnlyWithForgedCredential(): void {
  const Real = window.RTCPeerConnection;
  class RelayOnly extends Real {
    constructor(config?: RTCConfiguration) {
      super({ ...config, iceTransportPolicy: "relay" });
    }
    setConfiguration(config?: RTCConfiguration): void {
      super.setConfiguration({ ...config, iceTransportPolicy: "relay" });
    }
  }
  window.RTCPeerConnection = RelayOnly;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await realFetch(input, init);
    if (!String(input instanceof Request ? input.url : input).endsWith("/api/ice")) return res;
    const body = (await res.json()) as { iceServers: RTCIceServer[]; ttlSec: number };
    for (const s of body.iceServers) if (s.credential) s.credential = "forged-" + s.credential;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

const relayed = (p: Person) =>
  p.page.evaluate(() => Object.values(window.__store?.getState().peers ?? {}).map((x) => x.quality?.relayed ?? null));

let alice: Person;
let bob: Person;
test.afterEach(async () => {
  await leave(alice, bob);
});

test("a call connects through the TURN relay when direct routes are blocked", async ({ browser }) => {
  alice = await join(browser, "Alice", relayOnly);
  bob = await join(browser, "Bob", relayOnly);
  await walkIntoCall(alice, bob);

  await expect.poll(() => allPeersConnected(alice.page), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => allPeersConnected(bob.page), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => playingRemote(alice.page, "audio")).toBe(true);
  await expect.poll(() => playingRemote(bob.page, "audio")).toBe(true);
  // The quality sampler sees the active route going through the relay.
  await expect.poll(() => relayed(alice)).toEqual([true]);
});

test("the relay refuses credentials the server didn't sign", async ({ browser }) => {
  alice = await join(browser, "Alice", relayOnlyWithForgedCredential);
  bob = await join(browser, "Bob", relayOnlyWithForgedCredential);
  await walkIntoCall(alice, bob);

  // Make sure the forgery is really in place (a broken init script would
  // silently fall back to direct routes and connect anyway).
  const policy = await alice.page.evaluate(
    () => [...(window.__session?.peers?.peers.values() ?? [])][0]?.pc.getConfiguration().iceTransportPolicy,
  );
  expect(policy).toBe("relay");

  // With every route through a relay that rejects them, the call can't connect.
  await alice.page.waitForTimeout(10_000);
  expect(await allPeersConnected(alice.page)).toBe(false);
  expect(await allPeersConnected(bob.page)).toBe(false);
});
