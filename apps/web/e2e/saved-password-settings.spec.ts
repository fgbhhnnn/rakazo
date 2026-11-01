import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("account password consent defaults off and persists", async ({ page }, testInfo) => {
  await signup(page, `password-settings-${Date.now()}@rakazo.test`, "password12", "Settings");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  await settings.getByRole("button", { name: "Advanced", exact: true }).click();
  const toggle = settings.getByRole("switch", {
    name: "Allow bots to use saved passwords directly",
  });
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await toggle.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "saved-password-account-consent");
  await page.reload();
  const reopened = await openUserSettings(page);
  await reopened.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(
    reopened.getByRole("switch", { name: "Allow bots to use saved passwords directly" }),
  ).toBeChecked();
});
