import { expect, test } from "@playwright/test";
import { completeOnboarding, signup } from "./helpers";

test("dictation previews Chinese and leaves the message in the draft", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    // Drive the browser boundary deterministically without microphone access or a speech service.
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: class {
        onresult: ((event: unknown) => void) | null = null;
        onend: (() => void) | null = null;
        start() {
          this.onresult?.({ resultIndex: 0, results: [[{ transcript: "你好世界" }]] });
        }
        stop() {}
        abort() {}
      },
    });
  });
  await signup(page, `dictation-${Date.now()}@rakazo.test`, "password12", "Draft Writer");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /Message/ });
  await composer.fill("Review");
  let sends = 0;
  page.on("request", (request) => {
    if (request.url().includes("/rpc/threads/send")) sends += 1;
  });
  await page.getByRole("button", { name: "Dictate", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "你好世界" })).toBeVisible();
  await expect(composer).toHaveValue("Review");
  const path = testInfo.outputPath("composer-dictation.png");
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach("Composer dictation", { path, contentType: "image/png" });
  await page.getByRole("button", { name: "Stop dictation", exact: true }).click();
  await expect(composer).toHaveValue("Review 你好世界");
  await page.reload();
  await expect(composer).toHaveValue("Review 你好世界");
  expect(sends).toBe(0);
});
