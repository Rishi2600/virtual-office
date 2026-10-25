import { expect, test } from "@playwright/test";
import { allPeersConnected, join, leave, type Person } from "./helpers.js";

let people: Person[] = [];

test.afterEach(async () => {
  await leave(...people);
  people = [];
});

test("everyone gets a name pill on the map", async ({ browser }) => {
  const alice = await join(browser, "Alice");
  const bob = await join(browser, "Bob");
  people = [alice, bob];
  await expect(alice.page.getByTestId("name-pill").filter({ hasText: bob.name })).toHaveCount(1);
  await expect(alice.page.getByTestId("name-pill").filter({ hasText: alice.name })).toHaveCount(1);
});

test("'Walk to' in the people list walks you into their call", async ({ browser }) => {
  const alice = await join(browser, "Alice");
  const bob = await join(browser, "Bob");
  people = [alice, bob];

  await alice.page.getByRole("button", { name: `Walk to ${bob.name}` }).click();
  await expect.poll(() => allPeersConnected(alice.page), { timeout: 30_000 }).toBe(true);
  await expect(alice.page.getByTestId("huddle")).toBeVisible();
});

test("a phone-sized screen gets a friendly page, not the office", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const page = await context.newPage();
  await page.goto("/?dev=Phone");
  await expect(page.getByTestId("phone-block")).toBeVisible();
  await expect(page.getByTestId("dock")).toHaveCount(0);
  await context.close();
});

test("Ctrl K finds a person and Enter walks you to them", async ({ browser }) => {
  const alice = await join(browser, "Alice");
  const bob = await join(browser, "Bob");
  people = [alice, bob];

  await alice.page.keyboard.press("Control+k");
  const field = alice.page.getByRole("combobox", { name: "Name" });
  await expect(field).toBeFocused();
  await field.fill(bob.name.slice(0, 5));
  await expect(alice.page.getByRole("option", { name: new RegExp(bob.name) })).toHaveAttribute("aria-selected", "true");
  await field.press("Enter");

  await expect(alice.page.getByTestId("finder")).not.toBeVisible();
  await expect.poll(() => allPeersConnected(alice.page), { timeout: 30_000 }).toBe(true);
});
