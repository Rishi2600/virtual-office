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
  const button = carol.page.getByRole("button", { name: "Turn on video" });

  await button.click();
  await expect(carol.page.getByText("Camera blocked in your browser")).toBeVisible();

  // A second click asks again instead of replaying the cached failure.
  await button.click();
  await expect(carol.page.getByRole("button", { name: "Stop video" })).toBeVisible();
  await expect(carol.page.getByText("Camera blocked in your browser")).toHaveCount(0);
});
