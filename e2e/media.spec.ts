import { expect, test } from "@playwright/test";
import { join, leave, type Person } from "./helpers.js";

let carol: Person | undefined;

test.afterEach(async () => {
  if (carol) await leave(carol);
  carol = undefined;
});

/** Makes the first camera request fail as if the user clicked "Block". */
function denyCameraOnce(): void {
  const devices = navigator.mediaDevices;
  const real = devices.getUserMedia.bind(devices);
  let denied = false;
  devices.getUserMedia = (constraints?: MediaStreamConstraints) => {
    if (constraints?.video && !denied) {
      denied = true;
      return Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
    }
    return real(constraints);
  };
}

test("the camera can be retried after it was denied", async ({ browser }) => {
  carol = await join(browser, "Carol", denyCameraOnce);
  await carol.page.getByRole("button", { name: "Turn camera on" }).click();
  await expect(carol.page.getByText("Camera blocked in your browser")).toBeVisible();

  // The button now says it's blocked, and a second click asks again instead
  // of replaying the cached failure.
  await carol.page.getByRole("button", { name: "Camera blocked: try again" }).click();
  await expect(carol.page.getByRole("button", { name: "Turn camera off" })).toBeVisible();
  await expect(carol.page.getByText("Camera blocked in your browser")).toHaveCount(0);
});

test("picking another microphone in Settings swaps it in and is remembered", async ({ browser }) => {
  carol = await join(browser, "Carol");
  const page = carol.page;
  const micLabel = () =>
    page.evaluate(() => (window.__store?.getState() as unknown as { localStream: MediaStream | null }).localStream?.getAudioTracks()[0]?.label ?? "");
  await expect.poll(micLabel).not.toBe("");

  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const select = page.getByLabel("Microphone", { exact: true });
  const second = (await select.locator("option").allTextContents())[2]!;
  await select.selectOption({ label: second });

  await expect.poll(micLabel).toBe(second);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("lamports:prefs") ?? "{}").micDeviceId)).not.toBe("");
});
