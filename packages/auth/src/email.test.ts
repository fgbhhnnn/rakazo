import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_NAME } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  accountDeletionEmail,
  CATALOGS,
  emailLocale,
  emailText,
  identityCodeEmail,
  passwordResetEmail,
  signInCodeEmail,
  verificationEmail,
} from "./email.js";
import {
  integrationClaimConfirmEmail,
  pluginSubmissionAdminEmail,
  pluginSubmissionReceivedEmail,
  pluginSubmissionReviewedEmail,
} from "./plugin-submission-email.js";
import { referralEmail } from "./referral-email.js";
import { welcomeEmail } from "./welcome-email.js";

describe("account email templates", () => {
  const url = "https://app.example.test/verify?token=fake-token&callbackURL=%2Fsign-in";

  it.each([
    ["verification", () => verificationEmail("user@example.test", url)],
    [
      "password reset",
      () => passwordResetEmail({ id: "user-1", email: "user@example.test", name: "Test" }, url),
    ],
  ] as const)("preserves the exact %s link in HTML and text", async (_name, create) => {
    const message = await create();
    expect(message.to).toBe("user@example.test");
    expect(message.text).toContain(url);
    expect(message.html).toContain(`href="${url.replaceAll("&", "&amp;")}"`);
  });

  it.each([signInCodeEmail, accountDeletionEmail])(
    "escapes code content and includes a plain-text fallback",
    async (create) => {
      const message = await create("user@example.test", "<script>fake-code</script>");
      expect(message.text).toContain("<script>fake-code</script>");
      expect(message.html).toContain("&lt;script&gt;fake-code&lt;/script&gt;");
      expect(message.html).not.toContain("<script>");
      expect(message.html).not.toContain("<a ");
    },
  );
});

// Every template must retain the same layout and a text alternative.
it("shares the layout across account, product and marketplace emails", async () => {
  const user = { id: "user-1", name: "Alex", email: "alex@example.com" };
  const url = "https://app.example.com";
  const messages = await Promise.all([
    verificationEmail(user.email, url),
    signInCodeEmail(user.email, "123456"),
    passwordResetEmail(user, url),
    accountDeletionEmail(user.email, "123456"),
    identityCodeEmail(user.email, "123456"),
    welcomeEmail(user, url),
    referralEmail(user, url, url),
    pluginSubmissionReceivedEmail(user.email),
    integrationClaimConfirmEmail(user.email, url),
    pluginSubmissionAdminEmail(
      user.email,
      { name: "Example plugin", source: "https://example.com/plugin", email: user.email },
      url,
    ),
    pluginSubmissionReviewedEmail({
      email: user.email,
      name: "Example plugin",
      status: "approved",
      reason: null,
    }),
    pluginSubmissionReviewedEmail({
      email: user.email,
      name: "Example plugin",
      status: "rejected",
      reason: "Example reason",
    }),
  ]);
  for (const message of messages) {
    expect(message.html!.match(/class="email-card"/g)).toHaveLength(1);
    expect(message.html).toContain('role="presentation"');
    expect(message.text.length).toBeGreaterThan(0);
    expect(message.text).not.toContain("<table");
  }
});

describe("email languages", () => {
  const headers = (value: string) => new Headers({ "accept-language": value });

  it("writes in the saved app language, else the asking browser's, else English", () => {
    expect(emailLocale("es", headers("de-DE,de;q=0.9"))).toBe("es");
    expect(emailLocale(null, headers("es-CL,es;q=0.9,en;q=0.8"))).toBe("es");
    expect(emailLocale(undefined, headers("it-IT"))).toBe("en");
    expect(emailLocale("it", headers("es-ES"))).toBe("en");
    expect(emailLocale(null, headers("it-IT,es;q=0.9"))).toBe("es");
    expect(emailLocale(null, headers("en-US,es;q=0.9"))).toBe("en");
    expect(emailLocale(null, headers("*"))).toBe("en");
    expect(emailLocale(null, null)).toBe("en");
  });

  it.each([
    ["de-DE", "de"],
    ["fr-FR", "fr"],
    ["iw-IL", "he"],
    ["hi-IN", "hi"],
    ["ja-JP", "ja"],
    ["ko-KR", "ko"],
    ["nl-NL", "nl"],
    ["pt", "pt-BR"],
    ["ru-RU", "ru"],
    ["tr-TR", "tr"],
    ["zh-Hans-TW", "zh-CN"],
    ["zh-Hant-HK", "zh-TW"],
  ])("matches %s to the %s email catalog", (tag, locale) => {
    expect(emailLocale(tag, headers("en-US"))).toBe(locale);
    expect(emailLocale(null, headers(`${tag},en;q=0.9`))).toBe(locale);
  });

  it("writes a code email in Spanish", async () => {
    const message = await signInCodeEmail("user@example.test", "123456", "es");
    expect(message.subject).toBe(`Tu código para iniciar sesión en ${PRODUCT_NAME}`);
    expect(message.html).toContain('lang="es"');
    expect(message.text).toContain(`Introduce este código para iniciar sesión en ${PRODUCT_NAME}:`);
    expect(message.html).toContain('dir="ltr"');
  });

  it("lays a right-to-left language out right to left", async () => {
    const message = await integrationClaimConfirmEmail(
      "user@example.test",
      "https://example.test/claim",
      "he",
    );
    expect(message.html).toContain('lang="he"');
    expect(message.html).toContain('dir="rtl"');
  });

  it("greets by name in Spanish and keeps English as written", async () => {
    const user = { id: "user-1", email: "user@example.test", name: "Ana" };
    expect((await passwordResetEmail(user, "https://example.test/r", "es")).text).toContain(
      "Hola, Ana:",
    );
    const english = await welcomeEmail(user, "https://example.test/u");
    expect(english.subject).toBe(`Welcome to ${PRODUCT_NAME}`);
    expect(english.text).toContain("Hi Ana,");
    expect(english.text).toContain(`${PRODUCT_NAME} also has apps for iPhone`);
  });

  it.each([
    ["en", `Your ${PRODUCT_NAME} plugin submission: Rakazo tools`],
    ["es", `Tu envío de plugin a ${PRODUCT_NAME}: Rakazo tools`],
  ])("keeps user-provided names intact while branding %s email copy", (locale, expected) => {
    expect(
      emailText(locale)("Your Rakazo plugin submission: {name}", { name: "Rakazo tools" }),
    ).toBe(expected);
  });

  it.each(Object.entries(CATALOGS))(
    "renders page claim confirmation and review emails in %s with fork branding",
    async (locale, catalog) => {
      const email = "user@example.test";
      const url = "https://example.test/claim?token=fake-token&source=email";
      const name = "Rakazo tools";
      const expected = (key: string) =>
        catalog[key]!.replaceAll("Rakazo", PRODUCT_NAME).replaceAll("{name}", name);
      const confirmation = await integrationClaimConfirmEmail(email, url, locale);
      expect(confirmation.subject).toBe(expected("Confirm your Rakazo page claim"));
      expect(confirmation.html).toContain(`lang="${locale}"`);
      expect(confirmation.html).toContain(`href="${url.replaceAll("&", "&amp;")}"`);
      expect(confirmation.text).toContain(url);
      for (const key of [
        "Confirm claim",
        "We review every claim once it's confirmed and will email you when it's done.",
        "This link expires in one day. If you did not claim a page, ignore this email.",
      ]) {
        expect(confirmation.text).toContain(expected(key));
      }
      for (const status of ["approved", "rejected"] as const) {
        const reviewed = await pluginSubmissionReviewedEmail(
          { email, name, status, reason: null, claim: true },
          locale,
        );
        expect(reviewed.subject).toBe(expected("Your Rakazo page claim: {name}"));
        expect(reviewed.text).toContain(
          expected(
            status === "approved"
              ? "Your changes to the {name} page are approved."
              : "We couldn't approve your changes to the {name} page.",
          ),
        );
      }
    },
  );

  it.each(Object.entries(CATALOGS))(
    "translates every email string into %s with its placeholders",
    (_locale, catalog) => {
      const dir = dirname(fileURLToPath(import.meta.url));
      const ids = readdirSync(dir)
        .filter((file) => file.endsWith(".tsx"))
        .flatMap((file) =>
          [...readFileSync(join(dir, file), "utf8").matchAll(/say\(\s*("(?:[^"\\]|\\.)*")/g)].map(
            (match) => JSON.parse(match[1] ?? '""') as string,
          ),
        );
      expect(ids.length).toBeGreaterThan(30);
      const placeholders = (text: string) => [...text.matchAll(/\{\w+\}/g)].map(String).sort();
      for (const id of ids) {
        expect(catalog[id], id).toBeTruthy();
        expect(placeholders(catalog[id] ?? ""), id).toEqual(placeholders(id));
      }
    },
  );
});
