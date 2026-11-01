import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mobileRoot = new URL("../", import.meta.url);
const { expo } = JSON.parse(readFileSync(new URL("app.json", mobileRoot), "utf8"));

describe("1.0.8 OTA native configuration", () => {
  it("keeps the installed binary's phone-only iOS configuration", () => {
    expect(expo.ios.supportsTablet).toBe(false);
  });

  it("retains outbound sharing without adding native incoming-share configuration", () => {
    const plugins = expo.plugins.filter(
      (plugin: string | [string, unknown]) =>
        (Array.isArray(plugin) ? plugin[0] : plugin) === "expo-sharing",
    );
    expect(plugins).toEqual(["expo-sharing"]);
  });

  it("keeps Spanish translations in JS without adding Android native resources", () => {
    expect(existsSync(new URL("lib/locales/es.ts", mobileRoot))).toBe(true);
    for (const file of ["strings.xml", "call_strings.xml"]) {
      expect(
        existsSync(
          new URL(
            `modules/rakazo-notifications/android/src/main/res/values-es/${file}`,
            mobileRoot,
          ),
        ),
      ).toBe(false);
    }
  });
});
