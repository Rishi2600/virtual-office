import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { allPeersConnected, join, leave, type Person } from "./helpers.js";

/**
 * Automated accessibility checks (axe-core) on every main screen and state:
 * WCAG 2.1 A and AA, which includes text contrast of at least 4.5:1. The map
 * canvas itself is a picture, so it's left out; everything drawn over it
 * (name pills, labels, banners, huddle bar, dock) is checked.
 */
async function expectAccessible(page: Page, what: string) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .exclude("[data-map-focus] canvas")
    .analyze();
  const summary = violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).slice(0, 4).join(" | ")}`);
  expect(summary, `${what}: accessibility problems`).toEqual([]);
}

let people: Person[] = [];

test.afterEach(async () => {
  await leave(...people);
  people = [];
});

test("the sign-in page", async ({ page }) => {
  await page.goto("/?error=auth");
  await expect(page.getByRole("heading", { name: /one walk away/ })).toBeVisible();
  await expectAccessible(page, "sign-in");
});

test("the office, in a huddle, and every dialog", async ({ browser }) => {
  const alice = await join(browser, "Alice");
  const bob = await join(browser, "Bob");
  people = [alice, bob];
  const page = alice.page;

  await page.getByRole("button", { name: `Walk to ${bob.name}` }).click();
  await expect.poll(() => allPeersConnected(page), { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId("huddle")).toBeVisible();
  await expectAccessible(page, "office with a huddle");

  await page.getByRole("button", { name: "More" }).click();
  await expectAccessible(page, "more menu");
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByTestId("settings")).toBeVisible();
  await expectAccessible(page, "settings");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("finder")).toBeVisible();
  await expect(page.getByRole("option", { name: new RegExp(bob.name) })).toBeVisible();
  await expectAccessible(page, "finder");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Edit avatar" }).click();
  await expect(page.getByTestId("avatar-builder")).toBeVisible();
  await expectAccessible(page, "avatar builder");
});
