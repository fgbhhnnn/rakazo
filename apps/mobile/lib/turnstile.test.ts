import { describe, expect, it } from "vitest";
import {
  captchaHeaders,
  parseTurnstileMessage,
  turnstileHtml,
} from "./turnstile";

describe("turnstile", () => {
  it("embeds the site key safely", () => {
    const html = turnstileHtml("0x4AAA</script>");
    expect(html).toContain("challenges.cloudflare.com/turnstile/v0/api.js");
    expect(html).not.toContain("0x4AAA</script>");
    expect(html).toContain("0x4AAA\\u003c/script>");
  });
  it("parses widget messages", () => {
    expect(parseTurnstileMessage('{"type":"token","token":"abc"}')).toEqual({
      type: "token",
      token: "abc",
    });
    expect(parseTurnstileMessage('{"type":"expired"}')).toEqual({
      type: "expired",
    });
    expect(parseTurnstileMessage('{"type":"error","code":"110200"}')).toEqual({
      type: "error",
      code: "110200",
    });
    expect(parseTurnstileMessage('{"type":"token","token":""}')).toBeNull();
    expect(parseTurnstileMessage("nope")).toBeNull();
  });
  it("only sends the header with a token", () => {
    expect(captchaHeaders(null)).toEqual({});
    expect(captchaHeaders("t")).toEqual({ "x-captcha-response": "t" });
  });
});
