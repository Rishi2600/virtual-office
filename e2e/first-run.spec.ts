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

test("opening Lamports in a second tab moves you there; Use here takes it back", async ({ browser }) => {
  // Same browser, same sign-in: tab B is the same person as tab A.
  const a = await join(browser, "Twotabs");
  const b = await a.context.newPage();
  await b.goto("/");
  await b.waitForFunction(() => window.__store?.getState().connection === "connected");

  // Newest tab wins: A steps out and says why.
  await expect(a.page.getByTestId("replaced-screen")).toContainText("You opened Lamports somewhere else");
  const names = (p: typeof b) =>
    p.evaluate(() => Object.values((window.__store!.getState() as unknown as { players: Record<string, { name: string }> }).players).map((x) => x.name));
  expect((await names(b)).filter((n) => n === a.name)).toHaveLength(1);

  // "Use here" brings A back, and B steps out instead.
  await a.page.getByRole("button", { name: "Use here" }).click();
  await a.page.waitForFunction(() => window.__store?.getState().connection === "connected");
  await expect(b.getByTestId("replaced-screen")).toBeVisible();
  await leave(a);
});

test("when your session is ended elsewhere, the office tab goes to the sign-in page", async ({ browser }) => {
  const a = await join(browser, "Endme");
  // Sign this browser's session out from outside the tab (as another device
  // or the admin command would end it).
  await a.context.request.post("/auth/logout");
  // The room re-checks sessions every 15 s and disconnects ended ones.
  await expect(a.page.getByRole("alert")).toContainText("You've been signed out", { timeout: 25_000 });
  await expect(a.page.getByRole("heading", { name: /one walk away/ })).toBeVisible();
  await a.context.close();
});
