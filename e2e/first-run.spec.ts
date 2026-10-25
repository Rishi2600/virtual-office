import { expect, test } from "@playwright/test";

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
