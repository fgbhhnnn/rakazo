import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  rpc,
  signup,
  stopActiveWork,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test("approval input resumes durable work", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `approval-${stamp}@rakazo.test`, "password12", "Approval");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("ask me which city to use");
  await page.keyboard.press("Enter");

  const prompt = page.locator("p").filter({ hasText: /^Which city should I use\?$/ });
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Reply with one city name.", { exact: true })).toBeVisible();
  const botId = activeBotId(page);
  const readRun = async () =>
    (await rpc<{ run: { id: string; status: string } }>(page, "threads/get", { botId })).run;
  await expect.poll(async () => (await readRun()).status).toBe("waiting_input");
  const pending = await readRun();
  await captureScreenshot(page, testInfo, "20-approval-input-request");

  // Questions take their answer through the composer, including after a reload.
  await page.reload();
  await expect(prompt).toBeVisible();
  await composer.fill("ask me which city to use again");
  await captureScreenshot(page, testInfo, "21-approval-custom-answer");
  await composer.press("Enter");

  await expect(prompt).toHaveCount(2, { timeout: 30_000 });
  const firstAnswer = page
    .getByTestId("message-user-bubble")
    .filter({ hasText: /^ask me which city to use again$/ });
  await expect(firstAnswer).toBeVisible();
  const questions = page
    .getByTestId("question-card")
    .filter({ hasText: "Which city should I use?" });
  await expect(questions.first()).toHaveClass(/opacity-50/);
  // Answering resumes the original durable run rather than creating a replacement.
  await expect.poll(readRun).toMatchObject({ id: pending.id, status: "waiting_input" });
  await captureScreenshot(page, testInfo, "22-second-approval-prompt");

  await composer.fill("Paris");
  await captureScreenshot(page, testInfo, "23-second-approval-answer");
  await composer.press("Enter");

  const resumed = page.getByText(
    "on it. i will work this in the background and come back with a result.",
    { exact: true },
  );
  await expect(resumed).toBeVisible({ timeout: 30_000 });
  const handledAnswer = page.getByText("done. i handled: Paris", { exact: true });
  await expect(handledAnswer).toBeVisible();
  const cityAnswer = page.getByTestId("message-user-bubble").filter({ hasText: /^Paris$/ });
  await expect(cityAnswer).toBeVisible();
  await expect(questions.nth(1)).toHaveClass(/opacity-50/);

  await page.reload();
  await expect(resumed).toBeVisible({ timeout: 20_000 });
  await expect(handledAnswer).toBeVisible();
  await expect(cityAnswer).toBeVisible();
  await expect(questions.nth(1)).toHaveClass(/opacity-50/);
  await captureScreenshot(page, testInfo, "24-approval-resumed-after-reload");

  await composer.fill("ask me which city to use");
  await page.keyboard.press("Enter");
  await expect(prompt).toHaveCount(3, { timeout: 30_000 });
  await stopActiveWork(page);
  await expect(page.getByText("No longer active", { exact: true })).toBeVisible();
  await expect(questions.nth(2)).toContainText("No longer active");
  await captureScreenshot(page, testInfo, "25-stopped-approval-prompt");
});
