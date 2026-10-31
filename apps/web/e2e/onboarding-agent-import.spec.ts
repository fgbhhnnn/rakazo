import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Bot } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, clickAndWaitForRpc, rpc, signup } from "./helpers";

/** Onboarding shows the model step only while the account needs a model; tests decide when. */
async function controlNeedsModel(page: Page, { survey = false } = {}) {
  const state = { needsModel: true };
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: state.needsModel, needsSignupSurvey: survey } },
    });
  });
  return state;
}

async function openImport(page: Page) {
  await page.goto("/app?settings=general");
  await page.getByRole("button", { name: "Import an agent", exact: true }).click();
  const panel = page.getByTestId("agent-import");
  await expect(panel.getByTestId("agent-import-choose")).toBeVisible();
  return panel;
}

async function importSimpleAgent(page: Page, home: string) {
  const panel = await openImport(page);
  mkdirSync(path.join(home, "workspace"), { recursive: true });
  writeFileSync(path.join(home, "workspace/SOUL.md"), "Calm.\n");
  writeFileSync(path.join(home, "workspace/IDENTITY.md"), "- **Name:** Pebble\n");
  await panel.getByTestId("agent-import-folder").setInputFiles(home);
  await clickAndWaitForRpc(
    page,
    panel.getByRole("button", { name: "Create", exact: true }),
    "bots/importCreate",
  );
  await expect(page.getByPlaceholder("Message Pebble")).toBeVisible();
}

test("a new user can import an agent from Settings after onboarding", async ({
  page,
}, testInfo) => {
  const model = await controlNeedsModel(page, { survey: true });
  await signup(page, `onboarding-import-${Date.now()}@rakazo.test`, "password12", "Importer");
  await expect(page.getByRole("heading", { name: "Welcome to Gose Bot" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: "Import an agent", exact: true })).toHaveCount(0);
  expect(await rpc<Bot[]>(page, "bots/list", {})).toEqual([]);
  model.needsModel = false;
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  const panel = await openImport(page);
  await captureScreenshot(page, testInfo, "onboarding-import-choose");

  const broken = testInfo.outputPath("broken.zip");
  writeFileSync(broken, Buffer.from("PK not really a zip"));
  await panel.getByTestId("agent-import-archive").setInputFiles(broken);
  await expect(panel.getByRole("alert")).toHaveText("This backup could not be read.");
  await captureScreenshot(page, testInfo, "onboarding-import-error");

  const home = testInfo.outputPath("openclaw-home");
  for (const [file, content] of Object.entries({
    "openclaw.json": `{
      agents: { defaults: { model: { primary: "deepseek/deepseek-flash" } } },
      mcp: { servers: { docs: { url: "https://mcp.example.com/mcp" } } },
    }`,
    ".env": "DEEPSEEK_API_KEY=placeholder-deepseek-key\n",
    "workspace/SOUL.md": "Calm and direct.\n",
    "workspace/IDENTITY.md": "- **Name:** Pebble\n",
    "cron/jobs.json": JSON.stringify({
      jobs: [
        {
          name: "morning",
          schedule: { kind: "cron", expr: "0 9 * * *" },
          payload: { kind: "agentTurn", message: "Summarise my day" },
        },
      ],
    }),
  })) {
    mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
    writeFileSync(path.join(home, file), content);
  }
  await panel.getByTestId("agent-import-folder").setInputFiles(home);
  const preview = panel.getByTestId("agent-import-preview");
  await expect(preview.getByRole("textbox", { name: "Name" })).toHaveValue("Pebble");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "onboarding-import-preview");

  // The model needs its provider's key: unusable until the key is included.
  const modelBox = preview
    .getByTestId("agent-import-model")
    .getByRole("checkbox", { name: "deepseek/deepseek-flash", exact: true });
  await expect(modelBox).toBeDisabled();
  await preview.getByRole("checkbox", { name: "Include API keys" }).click();
  await expect(
    preview
      .getByTestId("agent-import-keys")
      .getByRole("checkbox", { name: "DeepSeek", exact: true }),
  ).toBeChecked();
  await expect(modelBox).toBeEnabled();
  await expect(preview.getByTestId("agent-import-mcp")).toBeVisible();
  await expect(preview.getByTestId("agent-import-routines")).toBeVisible();
  await captureScreenshot(page, testInfo, "onboarding-import-preview-settings");
  // The placeholder key cannot be verified offline, so it is left out of this import.
  await preview.getByRole("checkbox", { name: "Include API keys" }).click();
  await expect(
    preview
      .getByTestId("agent-import-keys")
      .getByRole("checkbox", { name: "DeepSeek", exact: true }),
  ).toHaveCount(0);

  await clickAndWaitForRpc(
    page,
    preview.getByRole("button", { name: "Create", exact: true }),
    "bots/importCreate",
  );
  await expect(page.getByPlaceholder("Message Pebble")).toBeVisible();
  const botId = activeBotId(page);
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  expect(bots.find((bot) => bot.id === botId)?.name).toBe("Pebble");
  expect(bots.map((bot) => bot.name).sort()).toEqual(["Chief", "Pebble"]);
  await captureScreenshot(page, testInfo, "onboarding-import-done");
});

test("a new user who ignores import still starts with Chief", async ({ page }, testInfo) => {
  const model = await controlNeedsModel(page);
  await signup(page, `onboarding-no-import-${Date.now()}@rakazo.test`, "password12", "Plain");
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible({
    timeout: 20_000,
  });
  // Connecting a model is the one thing this step asks for.
  await expect(page.getByRole("button", { name: "Import an agent", exact: true })).toHaveCount(0);
  // Connecting a model elsewhere, then opening onboarding again, makes Chief exactly as
  // before. (A linked /onboarding/model stays on the model step on purpose.)
  model.needsModel = false;
  await page.goto("/onboarding");
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible({
    timeout: 20_000,
  });
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  expect(bots.map((bot) => bot.name)).toEqual(["Chief"]);
  await captureScreenshot(page, testInfo, "onboarding-chief-without-import");
});

test("with a model provided, onboarding finishes before Settings offers import", async ({
  page,
}, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: false, needsSignupSurvey: true } },
    });
  });
  await signup(page, `onboarding-import-ready-${Date.now()}@rakazo.test`, "password12", "Ready");
  await expect(page.getByRole("heading", { name: "Welcome to Gose Bot" })).toBeVisible();
  expect(await rpc<Bot[]>(page, "bots/list", {})).toEqual([]);
  await expect(page.getByRole("button", { name: "Import an agent", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  await importSimpleAgent(page, testInfo.outputPath("openclaw-ready"));
  expect((await rpc<Bot[]>(page, "bots/list", {})).map((bot) => bot.name).sort()).toEqual([
    "Chief",
    "Pebble",
  ]);
  await captureScreenshot(page, testInfo, "onboarding-settings-import-done");
});

test("an import after another tab finishes onboarding preserves the first bot", async ({
  page,
}, testInfo) => {
  await noOnboardingSteps(page);
  await signup(
    page,
    `onboarding-import-raced-ready-${Date.now()}@rakazo.test`,
    "password12",
    "Raced",
  );
  await expect(page.getByPlaceholder("Message Chief")).toBeVisible();
  const [chief] = await rpc<Bot[]>(page, "bots/list", {});
  const panel = await openImport(page);
  const home = testInfo.outputPath("openclaw-raced-ready");
  mkdirSync(path.join(home, "workspace"), { recursive: true });
  writeFileSync(path.join(home, "workspace/SOUL.md"), "Calm.\n");
  writeFileSync(path.join(home, "workspace/IDENTITY.md"), "- **Name:** Pebble\n");
  await panel.getByTestId("agent-import-folder").setInputFiles(home);
  await expect(panel.getByRole("textbox", { name: "Name" })).toHaveValue("Pebble");
  // A concurrent edit to the original bot must survive importing another bot.
  await rpc(page, "bots/update", {
    botId: chief!.id,
    instructions: "Keep the first bot's instructions.",
  });
  await clickAndWaitForRpc(
    page,
    panel.getByRole("button", { name: "Create", exact: true }),
    "bots/importCreate",
  );
  await expect(page.getByPlaceholder("Message Pebble")).toBeVisible();
  expect((await rpc<Bot>(page, "bots/get", { botId: chief!.id })).instructions).toBe(
    "Keep the first bot's instructions.",
  );
  expect((await rpc<Bot[]>(page, "bots/list", {})).map((bot) => bot.name).sort()).toEqual([
    "Chief",
    "Pebble",
  ]);
});

test("with a model already provided, ignoring import still starts with Chief at once", async ({
  page,
}) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: false, needsSignupSurvey: true } },
    });
  });
  await signup(page, `onboarding-no-import-ready-${Date.now()}@rakazo.test`, "password12", "Plain");
  await expect(page.getByRole("heading", { name: "Welcome to Gose Bot" })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible({
    timeout: 20_000,
  });
});

/** A self-hosted deployment that provides the model: no model step and no sign-up survey. */
async function noOnboardingSteps(page: Page) {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: { json: { ...body.json, needsModel: false, needsSignupSurvey: false } },
    });
  });
}

// Chief's fixed focus card is posted only when Chief has no intro run (the scripted test
// runtime, or no model when Chief was made); otherwise Chief's intro asks what it is for.
test("with no onboarding steps and no intro run, Chief's focus card leaves import to Settings", async ({
  page,
}, testInfo) => {
  await noOnboardingSteps(page);
  await signup(page, `onboarding-import-chief-${Date.now()}@rakazo.test`, "password12", "Host");
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible({
    timeout: 20_000,
  });
  const [chief] = await rpc<Bot[]>(page, "bots/list", {});
  const before = await rpc<Bot>(page, "bots/get", { botId: chief!.id });
  const card = page
    .getByText("What do you want me on first?", { exact: true })
    .locator("xpath=ancestor::div[contains(@class,'bg-card')][1]");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByRole("button", { name: "Import an agent", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "onboarding-chief-focus-card");
  await importSimpleAgent(page, testInfo.outputPath("openclaw-chief"));
  const bots = await rpc<Bot[]>(page, "bots/list", {});
  expect(bots.map((bot) => bot.name).sort()).toEqual(["Chief", "Pebble"]);
  const after = await rpc<Bot>(page, "bots/get", { botId: chief!.id });
  expect(after.instructions).toBe(before.instructions);
});

test("with no onboarding steps and no intro run, answering the focus card keeps the first bot unchanged", async ({
  page,
}) => {
  await noOnboardingSteps(page);
  await signup(
    page,
    `onboarding-import-chief-skip-${Date.now()}@rakazo.test`,
    "password12",
    "Skip",
  );
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible({
    timeout: 20_000,
  });
  const card = page
    .getByText("What do you want me on first?", { exact: true })
    .locator("xpath=ancestor::div[contains(@class,'bg-card')][1]");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByRole("button", { name: "Import an agent", exact: true })).toHaveCount(0);
  expect((await rpc<Bot[]>(page, "bots/list", {})).map((bot) => bot.name)).toEqual(["Chief"]);
  // Answering the first-run question keeps the same first bot.
  await card.getByRole("button", { name: /Inbox & email/ }).click();
  await expect(card.getByRole("button", { name: "Import an agent", exact: true })).toHaveCount(0);
  expect((await rpc<Bot[]>(page, "bots/list", {})).map((bot) => bot.name)).toEqual(["Chief"]);
});
