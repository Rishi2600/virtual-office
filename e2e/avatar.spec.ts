import { expect, test } from "@playwright/test";
import { join, leave, type Person } from "./helpers.js";

let people: Person[] = [];

test.afterEach(async () => {
  await leave(...people);
  people = [];
});

const lookOf = (viewer: Person, who: Person) =>
  viewer.page.evaluate((name) => {
    const players = (window.__store?.getState() as unknown as { players: Record<string, { name: string; avatar: string }> }).players;
    return Object.values(players).find((p) => p.name === name)?.avatar ?? "";
  }, who.name);

test("a new look is saved, shown to others at once, and kept after a reload", async ({ browser }) => {
  const alice = await join(browser, "Alice");
  const bob = await join(browser, "Bob");
  people = [alice, bob];

  await alice.page.getByRole("button", { name: "More" }).click();
  await alice.page.getByRole("menuitem", { name: "Edit avatar" }).click();
  const builder = alice.page.getByTestId("avatar-builder");
  await expect(builder).toBeVisible();
  await builder.getByRole("radio", { name: "Cap" }).click();
  await builder.getByRole("radio", { name: "Skin 5" }).click();
  await builder.getByRole("button", { name: "Save" }).click();
  await expect(builder).toBeHidden();

  // skin 4 (0-based) … extra 3 (cap)
  await expect.poll(() => lookOf(bob, alice)).toMatch(/^4\.\d\.\d\.\d\.\d\.3$/);
  const saved = await lookOf(bob, alice);

  await alice.page.reload();
  await alice.page.waitForFunction(() => window.__store?.getState().connection === "connected");
  await expect(alice.page.getByTestId("avatar-builder")).toBeHidden();
  await expect.poll(() => lookOf(bob, alice)).toBe(saved);
});
