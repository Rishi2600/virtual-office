import { expect, test } from "@playwright/test";
import {
  allPeersConnected,
  framesDecodedDelta,
  isPolite,
  join,
  leave,
  playingRemote,
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
//  - test.fixme(): intermittent today (~45% in a 9-run sample), so it is
//    skipped rather than flapping CI; the fix branch enables it and proves it
//    with `--repeat-each`.

test("each person hears the other", async () => {
  await expect.poll(() => allPeersConnected(alice.page)).toBe(true);
  await expect.poll(() => playingRemote(alice.page, "audio")).toBe(true);
  await expect.poll(() => playingRemote(bob.page, "audio")).toBe(true);
});

test("negotiation settles on both sides", async () => {
  test.fixme(true, "RTC-2: intermittent; polite side can stay in have-local-offer");
  await expect.poll(() => allPeersConnected(alice.page)).toBe(true);
  await expect.poll(() => signalingStates(alice.page)).toEqual(["stable"]);
  await expect.poll(() => signalingStates(bob.page)).toEqual(["stable"]);
});

for (const role of ["impolite", "polite"] as const) {
  test(`camera from the ${role} side reaches the other person`, async () => {
    test.fixme(role === "polite", "RTC-2: intermittent; the polite side's offer can be dropped");
    await expect.poll(() => allPeersConnected(alice.page)).toBe(true);
    const alicePolite = await isPolite(alice.page);
    const [sender, receiver] = (role === "polite") === alicePolite ? [alice, bob] : [bob, alice];

    await sender.page.getByRole("button", { name: "Turn on video" }).click();
    await expect.poll(() => playingRemote(receiver.page, "video")).toBe(true);
  });
}

test("your own camera preview shows your video", async () => {
  test.fail(true, "UX-4: self-preview <video> mounts after its srcObject effect ran");
  await alice.page.getByRole("button", { name: "Turn on video" }).click();
  await expect
    .poll(() =>
      alice.page.evaluate(() => {
        const v = document.querySelector<HTMLVideoElement>(".self-preview video");
        return !!v && !v.paused && v.videoWidth > 0;
      }),
    )
    .toBe(true);
});

test("a screen share keeps flowing when the camera is toggled", async () => {
  test.fail(true, "RTC-5: camera toggles replace or clear the screen track");
  await expect.poll(() => allPeersConnected(alice.page)).toBe(true);
  // Share from the impolite side so this test isolates the share/camera logic
  // from the negotiation race covered above.
  const [sharer, viewer] = (await isPolite(alice.page)) ? [bob, alice] : [alice, bob];

  await sharer.page.getByRole("button", { name: "Share screen" }).click();
  await expect.poll(() => playingRemote(viewer.page, "video")).toBe(true);

  await sharer.page.getByRole("button", { name: "Turn on video" }).click();
  await sharer.page.getByRole("button", { name: "Stop video" }).click();
  await expect(sharer.page.getByRole("button", { name: "Stop sharing" })).toBeVisible();
  expect(await framesDecodedDelta(viewer.page)).toBeGreaterThan(0);
});
