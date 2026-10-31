import { z } from "zod";

/** A login obstacle, never a credential value or a guess that the password was wrong. */
export const LoginFailureReasonSchema = z.enum([
  "no_page_browser",
  "field_not_found",
  "password_rejected",
  "captcha_or_2fa",
  "site_error",
  "unknown",
]);

export type LoginFailureReason = z.infer<typeof LoginFailureReasonSchema>;
