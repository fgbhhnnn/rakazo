import { useEffect, useRef } from "react";

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type Turnstile = {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let scriptLoad: Promise<Turnstile> | undefined;

function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptLoad ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile missing"));
    script.onerror = () => {
      scriptLoad = undefined;
      reject(new Error("Could not load Turnstile"));
    };
    document.head.appendChild(script);
  });
  return scriptLoad;
}

/** Cloudflare Turnstile check; reports a token, or null when it expires or fails. */
export function TurnstileWidget({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const tokenRef = useRef(onToken);
  tokenRef.current = onToken;

  useEffect(() => {
    let widgetId: string | undefined;
    let live = true;
    void loadTurnstile()
      .then((turnstile) => {
        if (!live || !ref.current) return;
        widgetId = turnstile.render(ref.current, {
          sitekey: siteKey,
          callback: (token) => tokenRef.current(token),
          "expired-callback": () => tokenRef.current(null),
          "error-callback": () => tokenRef.current(null),
        });
      })
      .catch(() => tokenRef.current(null));
    return () => {
      live = false;
      if (widgetId) window.turnstile?.remove(widgetId);
      tokenRef.current(null);
    };
  }, [siteKey]);

  return <div ref={ref} data-testid="turnstile-widget" className="min-h-[65px]" />;
}
