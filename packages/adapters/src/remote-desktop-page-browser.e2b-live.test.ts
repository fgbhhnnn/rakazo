import { createHash } from "node:crypto";
import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import { createBrowserProvider } from "./browser-provider-factory.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";

// Explicit opt-in: ordinary test runs create no sandbox and make no network requests.
it.skipIf(!process.env.E2B_API_KEY || process.env.RAKAZO_E2B_LIVE !== "1")(
  "navigates, snapshots, and fills a saved password in the visible E2B browser",
  async () => {
    const provider = new E2BSandboxProvider(process.env.E2B_API_KEY!);
    const context: AdapterContext = {
      operationId: "live-page",
      traceId: "live-page",
      spaceId: "fixture-space",
      userId: "fixture-user",
      botId: "fixture-bot",
      screenLeaseId: "fixture:1",
      signal: AbortSignal.timeout(280_000),
    };
    let computer: ComputerRef | undefined;
    try {
      // Production selection prefers rakazo-computer and falls back to desktop if not built.
      computer = await provider.provision({ botId: "fixture-bot", homePath: "/unused" }, context);
      await provider.prepare(computer, context);
      const browser = createBrowserProvider("computer", { sandbox: provider });
      expect(browser.describe().capabilities.page).toBe(true);
      expect(
        (await browser.navigate(computer, { url: "https://example.com" }, context)).fallback,
      ).toBeUndefined();
      expect((await browser.snapshot(computer, {}, context)).title).toBe("Example Domain");

      // Saved passwords require HTTPS. Trust a disposable localhost certificate in this VM
      // rather than weakening the helper's origin policy to test a plain HTTP/data URL.
      const fixturePassword = "fake-e2b-fixture-password";
      const digest = createHash("sha256").update(fixturePassword).digest("hex");
      const server = `from http.server import BaseHTTPRequestHandler, HTTPServer
import hashlib, ssl
class Handler(BaseHTTPRequestHandler):
 def log_message(self, *args): pass
 def do_GET(self):
  self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers()
  self.wfile.write(b'''<title>Fixture</title><label>Password<input type="password" aria-label="Password" oninput="fetch('/verify',{method:'POST',body:this.value}).then(r=>r.text()).then(v=>document.title=v)"></label>''')
 def do_POST(self):
  data = self.rfile.read(int(self.headers.get('Content-Length', '0')))
  matched = hashlib.sha256(data).hexdigest() == '${digest}'
  self.send_response(200); self.end_headers(); self.wfile.write(b'filled' if matched else b'pending')
server = HTTPServer(('127.0.0.1', 8765), Handler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain('/tmp/rakazo-page-fixture.crt', '/tmp/rakazo-page-fixture.key')
server.socket = ctx.wrap_socket(server.socket, server_side=True)
server.serve_forever()
`;
      await provider.writeFile(
        computer,
        { path: "page-fixture.py", content: new TextEncoder().encode(server) },
        context,
      );
      const setup = [
        "set -eu",
        "command -v certutil >/dev/null || { sudo -n apt-get update -qq && sudo -n apt-get install -y -qq libnss3-tools; }",
        "openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/rakazo-page-fixture.key -out /tmp/rakazo-page-fixture.crt -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost >/dev/null 2>&1",
        'mkdir -p "$HOME/.pki/nssdb"',
        'test -f "$HOME/.pki/nssdb/cert9.db" || certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password',
        'certutil -A -d "sql:$HOME/.pki/nssdb" -n rakazo-page-fixture -t "C,," -i /tmp/rakazo-page-fixture.crt',
        "nohup python3 page-fixture.py </dev/null >/dev/null 2>&1 &",
      ].join("\n");
      for await (const event of provider.execute(
        computer,
        { argv: ["bash", "-c", setup], timeoutMs: 120_000 },
        context,
      )) {
        // Only assert the exit status; never include SDK output or fixture credentials in a failure.
        if (event.type === "exit") expect(event.code).toBe(0);
      }
      // Restart after certificate import; the bot's browser/profile and CDP ownership stay intact.
      await provider.releaseScreen(computer, context);
      const origin = "https://localhost:8765";
      expect((await browser.navigate(computer, { url: origin }, context)).fallback).toBeUndefined();
      const page = await browser.snapshot(computer, {}, context);
      const password = page.elements.find((element) => element.name === "Password");
      expect(Boolean(password)).toBe(true);
      const filled = await browser.act(
        computer,
        {
          actions: [
            { kind: "fill", ref: password!.ref, text: fixturePassword, origin, field: "password" },
          ],
        },
        context,
      );
      expect(filled.ok).toBe(true);
      expect(filled.completed).toBe(1);
      expect(JSON.stringify(filled).includes(fixturePassword)).toBe(false);
      await expect
        .poll(async () => (await browser.snapshot(computer!, {}, context)).title, {
          timeout: 10_000,
        })
        .toBe("filled");
    } finally {
      if (computer)
        await provider.destroy(computer, { ...context, signal: new AbortController().signal });
    }
  },
  300_000,
);
