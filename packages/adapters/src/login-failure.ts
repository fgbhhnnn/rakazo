import type { LoginFailureReason } from "@rakazo/contracts";

export function loginFailure(error: string, reason: LoginFailureReason = "unknown") {
  return { error, reason };
}

/** Classify only our page protocol's errors, never natural-language site content. */
export function loginFillFailure<T extends { error?: string }>(
  result: T,
): T & {
  reason?: LoginFailureReason;
} {
  if (!result.error) return result;
  const missing =
    /^(?:Stale element ref|Unknown element ref|Ref .* (?:not found|is not fillable))/i.test(
      result.error,
    );
  // A refused fill is not authentication rejection. Only the site can establish that.
  return { ...result, reason: missing ? "field_not_found" : "unknown" };
}

export const WORKER_LOGIN_FAILURE_GUIDANCE =
  "When a login attempt fails, report 登录失败（原因：<reason>） (to the dispatcher when working as a background worker), using the tool result reason or one of no_page_browser, field_not_found, password_rejected, captcha_or_2fa, site_error, unknown. Include the credential name/site and the observed obstacle, never its values. Use password_rejected only when the site explicitly rejects the submitted password; a fill refusal, missing field or unavailable browser is not password rejection. Use unknown when the cause is unclear. Never report only 登录失败.";

export const DISPATCHER_LOGIN_FAILURE_GUIDANCE =
  "After a worker login failure, use the existing credential and report the actual reason to the user. Do not request the same credential again, rename it, or switch its type to ask again unless the worker explicitly reports password_rejected; pass that failureReason to request_secret. If the worker gives no reason, ask the worker to diagnose it. A correction pasted in chat or a dismissed card is not evidence of password rejection. Keep one secure card per login; respect dismissal and do not immediately issue another card.";
