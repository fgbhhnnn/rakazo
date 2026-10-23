/** Cloudflare Turnstile for native signup, rendered inside a WebView. */
export const CAPTCHA_HEADER = "x-captcha-response";

export type TurnstileMessage =
  | { type: "token"; token: string }
  | { type: "expired" }
  | { type: "error"; code?: string };

/**
 * Page that renders one Turnstile widget and posts its outcome to the app.
 * Load it with the API origin as `baseUrl`, so Cloudflare sees the server's hostname.
 */
export function turnstileHtml(
  siteKey: string,
  theme: "light" | "dark" = "light",
): string {
  const options = JSON.stringify({ sitekey: siteKey, theme }).replace(
    /</g,
    "\\u003c",
  );
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>html,body{margin:0;padding:0;background:transparent;}#w{display:flex;justify-content:center;}</style>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTs&render=explicit" async defer></script>
</head><body><div id="w"></div><script>
function post(m){window.ReactNativeWebView&&window.ReactNativeWebView.postMessage(JSON.stringify(m));}
function onTs(){var o=${options};
o.callback=function(t){post({type:"token",token:t});};
o["expired-callback"]=function(){post({type:"expired"});};
o["error-callback"]=function(c){post({type:"error",code:String(c||"")});};
turnstile.render("#w",o);}
setTimeout(function(){if(!window.turnstile)post({type:"error",code:"load"});},15000);
</script></body></html>`;
}

export function parseTurnstileMessage(data: string): TurnstileMessage | null {
  try {
    const value = JSON.parse(data) as {
      type?: unknown;
      token?: unknown;
      code?: unknown;
    };
    if (
      value.type === "token" &&
      typeof value.token === "string" &&
      value.token
    )
      return { type: "token", token: value.token };
    if (value.type === "expired") return { type: "expired" };
    if (value.type === "error")
      return {
        type: "error",
        ...(typeof value.code === "string" ? { code: value.code } : {}),
      };
  } catch {}
  return null;
}

export function captchaHeaders(
  token: string | null | undefined,
): Record<string, string> {
  return token ? { [CAPTCHA_HEADER]: token } : {};
}
