import { expect, test } from "@playwright/test";
import { allPeersConnected, join, leave, playingRemote, type Person } from "./helpers.js";

/** A tablet held upright: 900×1100, touch only. */
const TABLET = { viewport: { width: 900, height: 1100 }, hasTouch: true };

let people: Person[] = [];

test.afterEach(async () => {
  await leave(...people);
  people = [];
});

test("on a tablet, touch alone gets you walking, talking, chatting and sharing", async ({ browser }) => {
  const tab = await join(browser, "Tablet", undefined, TABLET);
  const bob = await join(browser, "Bob");
  people = [tab, bob];
  const page = tab.page;

  // The tablet layout: faces-only people column, chat closed, big tap targets.
  await expect(page.getByTestId("dock")).toBeVisible();
  for (const button of await page.getByTestId("dock").getByRole("button").all()) {
    const box = await button.boundingBox();
    expect(box?.height ?? 0, "dock buttons are at least 44px tall").toBeGreaterThanOrEqual(44);
  }

  // Walk: zoom out until Bob is on screen, then tap the floor next to him.
  const bobPill = page.getByTestId("name-pill").filter({ hasText: bob.name });
  for (let i = 0; i < 3 && !(await bobPill.isVisible()); i++) {
    await page.getByRole("button", { name: "Zoom out (−)" }).tap();
    await page.waitForTimeout(300);
  }
  const pill = await bobPill.boundingBox();
  expect(pill, "Bob is on screen").not.toBeNull();
  await page.touchscreen.tap(pill!.x + pill!.width / 2 + 40, pill!.y - 8);
  await expect.poll(() => allPeersConnected(page), { timeout: 30_000 }).toBe(true);

  // Chat: open the drawer, type, send.
  await page.getByTestId("chat-toggle").tap();
  const box = page.getByRole("textbox", { name: "Message the people near you" });
  await box.tap();
  await box.fill("hello from the tablet");
  await page.getByRole("button", { name: "Send" }).tap();
  await expect(bob.page.getByTestId("chat-list")).toContainText("hello from the tablet");
  await page.getByRole("button", { name: "Hide chat" }).tap();

  // Share the screen.
  await page.getByRole("button", { name: "Share your screen" }).tap();
  await expect.poll(() => playingRemote(bob.page, "video")).toBe(true);
});
