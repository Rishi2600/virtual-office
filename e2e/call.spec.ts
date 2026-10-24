import { expect, test } from "@playwright/test";
import {
  allPeersConnected,
  framesDecodedDelta,
  isPolite,
  join,
  leave,
  playingRemote,
  sendingScreen,
  signalingStates,
  walkIntoCall,
  type Person,
} from "./helpers.js";

let alice: Person;
let bob: Person;

test.beforeEach(async ({ browser }) => {
  alice = await join(browser, "Alice");
  bob = await join(browser, "Bob");
  await walkIntoCall(alice, bob);
});

test.afterEach(async () => {
  await leave(alice, bob);
});

test("walking up to someone connects a call", async () => {
  await expect.poll(() => allPeersConnected(alice.page)).toBe(true);
  await expect.poll(() => allPeersConnected(bob.page)).toBe(true);
});

// Known bugs from docs/audit-2026-10-24.md are marked rather than deleted:
//  - test.fail():  fails every time today. When the fix lands the test
//    "unexpectedly passes", which fails CI until the marker is removed.
//  - test.fixme(): intermittent bugs, skipped rather than flapping CI; the fix
//    branch enables the test and proves it with `--repeat-each`.

test("each person hears the other", async () => {
  await expect.poll(() => allPeersConnected(alice.page)).toBe(true);
  await expect.poll(() => playingRemote(alice.page, "audio")).toBe(true);
  await expect.poll(() => playingRemote(bob.page, "audio")).toBe(true);
});

test("negotiation settles on both sides", async () => {
  await expect.poll(() => allPeersConnected(alice.page)).toBe(true);
  await expect.poll(() => signalingStates(alice.page)).toEqual(["stable"]);
  await expect.poll(() => signalingStates(bob.page)).toEqual(["stable"]);
});

for (const role of ["impolite", "polite"] as const) {
  test(`camera from the ${role} side reaches the other person`, async () => {
    await expect.poll(() => allPeersConnected(alice.page)).toBe(true);
    const alicePolite = await isPolite(alice.page);
    const [sender, receiver] = (role === "polite") === alicePolite ? [alice, bob] : [bob, alice];

    await sender.page.getByRole("button", { name: "Turn on video" }).click();
    await expect.poll(() => playingRemote(receiver.page, "video")).toBe(true);
  });
}

test("turning the camera off brings back the initial", async () => {
  await expect.poll(() => allPeersConnected(alice.page)).toBe(true);
  const placeholder = bob.page.locator(".bubble-placeholder");

  await alice.page.getByRole("button", { name: "Turn on video" }).click();
  await expect.poll(() => playingRemote(bob.page, "video")).toBe(true);
  await expect(placeholder).toHaveCount(0);

  await alice.page.getByRole("button", { name: "Stop video" }).click();
  await expect(placeholder).toBeVisible();
});

const selfPreviewPlaying = (person: Person) =>
  person.page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>(".self-preview video");
    return !!v && !v.paused && v.videoWidth > 0;
  });

test("your own camera preview shows your video", async () => {
  await alice.page.getByRole("button", { name: "Turn on video" }).click();
  await expect.poll(() => selfPreviewPlaying(alice)).toBe(true);
});

test("a screen share keeps flowing when the camera is toggled", async () => {
  await expect.poll(() => allPeersConnected(alice.page)).toBe(true);
  const sharer = alice;
  const viewer = bob;

  await sharer.page.getByRole("button", { name: "Share screen" }).click();
  await expect.poll(() => playingRemote(viewer.page, "video")).toBe(true);
  await expect.poll(() => sendingScreen(sharer.page)).toBe(true);
  // Your own screen preview is shown as-is, not mirrored like a camera.
  await expect(sharer.page.locator(".self-preview video")).toHaveCSS("transform", "none");

  // Turning the camera on mid-share must not replace the screen...
  await sharer.page.getByRole("button", { name: "Turn on video" }).click();
  await expect(sharer.page.getByRole("button", { name: "Stop video" })).toBeVisible();
  expect(await sendingScreen(sharer.page)).toBe(true);

  // ...and turning it off must not stop the share.
  await sharer.page.getByRole("button", { name: "Stop video" }).click();
  await expect(sharer.page.getByRole("button", { name: "Turn on video" })).toBeVisible();
  expect(await sendingScreen(sharer.page)).toBe(true);
  expect(await framesDecodedDelta(viewer.page)).toBeGreaterThan(0);
});
