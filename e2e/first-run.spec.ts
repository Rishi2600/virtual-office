import { expect, test } from "@playwright/test";
import { join, leave } from "./helpers.js";

test("a failed sign-in says so once, and the error leaves the address bar", async ({ page }) => {
  await page.goto("/?error=auth");
  await expect(page.getByRole("heading", { name: /one walk away/ })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Sign-in didn't finish");
  await expect(page).toHaveURL(/\/$/);
});

test("first visit: sign in, build an avatar, read the intro once", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Name for local testing").fill(`Newbie-${Math.random().toString(36).slice(2, 6)}`);
  await page.getByRole("button", { name: "Enter" }).click();

  // You're in the office before answering anything; the builder opens first…
  const builder = page.getByTestId("avatar-builder");
  await expect(builder).toBeVisible();
  await expect(page.getByTestId("dock")).toBeAttached();
  await builder.getByRole("button", { name: "Save" }).click();
  await expect(builder).toBeHidden();

  // …then the intro, once.
  await expect(page.getByTestId("intro")).toBeVisible();
  await page.getByRole("button", { name: "Got it" }).click();
  await expect(page.getByTestId("intro")).toBeHidden();
  await page.reload();
  await page.waitForFunction(() => window.__store?.getState().connection === "connected");
  await expect(page.getByTestId("avatar-builder")).toBeHidden();
  await expect(page.getByTestId("intro")).toHaveCount(0);
  await page.evaluate(() => window.__session?.disconnect());
});

test("Leave office, then Rejoin: back in, and the map still works", async ({ browser }) => {
  const me = await join(browser, "Leaver");
  const page = me.page;
  const x = () =>
    page.evaluate(() => (window as unknown as { __game: { scene: { keys: { office: { predicted: { x: number } } } } } }).__game.scene.keys.office.predicted.x);

  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Leave office" }).click();
  await expect(page.getByTestId("left-screen")).toBeVisible();
  await page.getByRole("button", { name: "Rejoin" }).click();
  await page.waitForFunction(() => window.__store?.getState().connection === "connected");

  const before = await x();
  await page.locator("[data-map-focus]").focus();
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(500);
  await page.keyboard.up("ArrowRight");
  await expect.poll(x).toBeGreaterThan(before + 20);
  await leave(me);
});

test("signing out in one tab signs that session out in the others too", async ({ browser }) => {
  // Tab A signs in (dev sign-in also sets the session cookie); tab B, in the
  // same browser, uses that cookie: the same session.
  const a = await join(browser, "Twotabs");
  const b = await a.context.newPage();
  await b.goto("/");
  await b.waitForFunction(() => window.__store?.getState().connection === "connected");

  await a.page.getByRole("button", { name: /^Account/ }).click();
  await a.page.getByRole("menuitem", { name: "Sign out" }).click();

  // The room re-checks sessions every 15 s; B is sent to the sign-in page.
  await expect(b.getByRole("alert")).toContainText("You've been signed out", { timeout: 25_000 });
  await expect(b.getByRole("heading", { name: /one walk away/ })).toBeVisible();
  await a.context.close();
});
