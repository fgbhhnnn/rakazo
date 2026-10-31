import { describe, expect, it } from "vitest";
import { LoginFailureReasonSchema } from "./login-failure.js";

it.each(LoginFailureReasonSchema.options)("accepts the structured reason %s", (reason) => {
  expect(LoginFailureReasonSchema.parse(reason)).toBe(reason);
});

describe("login failure reasons", () => {
  it("rejects free-form reports and credential values", () => {
    for (const reason of ["登录失败", "fake-password", "fill_refused", undefined])
      expect(LoginFailureReasonSchema.safeParse(reason).success).toBe(false);
  });
});
