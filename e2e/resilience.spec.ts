import { expect, test } from "@playwright/test";
import { allPeersConnected, join, leave, restartCount, simulateConnectionState, walkIntoCall, type Person } from "./helpers.js";

let alice: Person;
let bob: Person;

test.beforeEach(async ({ browser }) => {
  alice = await join(browser, "Alice");
  bob = await join(browser, "Bob");
  await walkIntoCall(alice, bob);
  await expect.poll(() => allPeersConnected(alice.page)).toBe(true);
  await expect.poll(() => allPeersConnected(bob.page)).toBe(true);
});

test.afterEach(async () => {
  await leave(alice, bob);
});

test("connection quality is shown for a healthy call", async () => {
  for (const p of [alice, bob]) {
    await expect(p.page.locator('.bubble-quality[data-quality="good"]')).toBeVisible();
  }
});

test("a failed call retries with back-off and says so, then recovers", async () => {
  const tile = alice.page.locator(".bubble");
  await simulateConnectionState(alice.page, "failed");

  // Straight to a retry, shown as "reconnecting…".
  await expect(tile).toHaveAttribute("data-status", "reconnecting");
  await expect(alice.page.locator(".bubble-overlay")).toContainText("reconnecting…");
  await expect.poll(() => restartCount(alice.page)).toBeGreaterThanOrEqual(1);

  // After the quick attempts (0s, 2s, 4s, 8s) it admits it can't connect, but keeps trying.
  await expect(alice.page.locator(".bubble-overlay")).toContainText("can't connect", { timeout: 25_000 });
  await expect(alice.page.locator(".bubble-overlay-hint")).toContainText("still trying");
  expect(await restartCount(alice.page)).toBe(4);

  // Back on the network: the overlay clears and the quality dot returns.
  await simulateConnectionState(alice.page, null);
  await expect(tile).toHaveAttribute("data-status", "connected");
  await expect(alice.page.locator(".bubble-overlay")).toHaveCount(0);
  await expect(alice.page.locator(".bubble-quality")).toBeVisible();
});

test("a brief disconnect heals without a restart; a lasting one is recovered", async () => {
  const tile = alice.page.locator(".bubble");

  await simulateConnectionState(alice.page, "disconnected");
  await alice.page.waitForTimeout(1_000);
  await simulateConnectionState(alice.page, null);
  await alice.page.waitForTimeout(4_500); // past the grace period
  expect(await restartCount(alice.page)).toBe(0);
  await expect(tile).toHaveAttribute("data-status", "connected");

  await simulateConnectionState(alice.page, "disconnected");
  await expect(tile).toHaveAttribute("data-status", "reconnecting", { timeout: 8_000 });
  await expect.poll(() => restartCount(alice.page)).toBeGreaterThanOrEqual(1);
  await simulateConnectionState(alice.page, null);
  await expect(tile).toHaveAttribute("data-status", "connected");
});
