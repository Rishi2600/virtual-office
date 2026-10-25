import { expect, test } from "@playwright/test";
import { join, leave, type Person } from "./helpers.js";

let people: Person[] = [];

test.afterEach(async () => {
  await leave(...people);
  people = [];
});

test("Enter to chat, Esc back to the map, and unread counts in the tab title", async ({ browser }) => {
  const alice = await join(browser, "Alice");
  const bob = await join(browser, "Bob");
  people = [alice, bob];

  // Alone, Enter goes to the Everyone box (Nearby needs someone near you).
  await alice.page.locator("[data-map-focus]").focus();
  await alice.page.keyboard.press("Enter");
  const box = alice.page.getByRole("textbox", { name: "Message everyone" });
  await expect(box).toBeFocused();
  await box.fill("hello office");
  await box.press("Enter");
  await box.press("Escape");
  await expect(alice.page.locator("[data-map-focus]")).toBeFocused();

  // Bob is looking at Nearby, so the message is unread, shown in his tab title.
  await expect(bob.page).toHaveTitle("(1) Lamports");
  await bob.page.getByRole("tab", { name: /Everyone/ }).click();
  await expect(bob.page.getByTestId("chat-list")).toContainText("hello office");
  await expect(bob.page).toHaveTitle("Lamports");
});
