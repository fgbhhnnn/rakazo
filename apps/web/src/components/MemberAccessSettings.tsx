import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input, Label, Switch } from "@rakazo/ui-web";
import { Disclosure } from "@rakazo/ui-web/components/ui/disclosure";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/** Owner-only controls: member settings lock, shared models, and signup bot check. */
export function MemberAccessSettings() {
  const { t } = useLingui();
  const lockId = useId();
  const shareId = useId();
  const turnstileId = useId();
  const siteKeyId = useId();
  const secretId = useId();
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof rpc.deployment.get>> | null>(
    null,
  );
  const [siteKey, setSiteKey] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    rpc.deployment
      .get()
      .then((next) => {
        if (!live) return;
        setSettings(next);
        setSiteKey(next.turnstileSiteKey ?? "");
      })
      .catch((cause) => live && setError(errorText(cause)));
    return () => {
      live = false;
    };
  }, []);

  async function save(input: Parameters<typeof rpc.deployment.update>[0]) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await rpc.deployment.update(input);
      setSettings(next);
      setSiteKey(next.turnstileSiteKey ?? "");
      setSecret("");
      setSaved(true);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Disclosure
      data-testid="member-access-settings"
      className="group rounded-xl border border-border"
      summary={<Trans>Members and sign-up</Trans>}
      summaryClassName="w-full flex items-center justify-between gap-4 px-4 py-4 text-[14px] text-foreground/75"
    >
      <div className="space-y-4 border-t border-border px-4 pt-5 pb-5">
        {!settings && !error ? (
          <p className="text-[13px] text-muted-foreground">
            <Trans>Loading…</Trans>
          </p>
        ) : null}
        {settings ? (
          <>
            <div className="flex items-start gap-3">
              <Switch
                id={lockId}
                data-testid="lock-member-settings-toggle"
                className="mt-0.5"
                disabled={busy}
                checked={settings.lockMemberSettings}
                onCheckedChange={(checked) => void save({ lockMemberSettings: checked })}
              />
              <Label htmlFor={lockId} className="text-[14px] font-normal text-foreground/75">
                <Trans>
                  Only I manage models, voice and MCP servers (members use mine and cannot change
                  them)
                </Trans>
              </Label>
            </div>
            <div className="flex items-start gap-3">
              <Switch
                id={shareId}
                data-testid="share-owner-models-toggle"
                className="mt-0.5"
                disabled={busy || settings.lockMemberSettings}
                checked={settings.shareOwnerModels || settings.lockMemberSettings}
                onCheckedChange={(checked) => void save({ shareOwnerModels: checked })}
              />
              <Label htmlFor={shareId} className="text-[14px] font-normal text-foreground/75">
                <Trans>Members without their own model or voice use my defaults</Trans>
              </Label>
            </div>
            <div className="flex items-start gap-3">
              <Switch
                id={turnstileId}
                data-testid="turnstile-toggle"
                className="mt-0.5"
                disabled={busy}
                checked={settings.turnstileEnabled}
                onCheckedChange={(checked) => void save({ turnstileEnabled: checked })}
              />
              <Label htmlFor={turnstileId} className="text-[14px] font-normal text-foreground/75">
                <Trans>Require a Cloudflare Turnstile check to create an account</Trans>
              </Label>
            </div>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void save({
                  turnstileSiteKey: siteKey.trim(),
                  ...(secret.trim() ? { turnstileSecretKey: secret.trim() } : {}),
                });
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor={siteKeyId} className="text-[13px]">
                  <Trans>Turnstile site key</Trans>
                </Label>
                <Input
                  id={siteKeyId}
                  value={siteKey}
                  autoComplete="off"
                  onChange={(event) => setSiteKey(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={secretId} className="text-[13px]">
                  <Trans>Turnstile secret key</Trans>
                </Label>
                <Input
                  id={secretId}
                  type="password"
                  value={secret}
                  autoComplete="new-password"
                  placeholder={settings.hasTurnstileSecret ? t`Saved — enter to replace` : ""}
                  onChange={(event) => setSecret(event.target.value)}
                />
              </div>
              <Button type="submit" size="sm" disabled={busy}>
                <Trans>Save keys</Trans>
              </Button>
            </form>
          </>
        ) : null}
        {saved ? (
          <p className="text-[12.5px] text-muted-foreground">
            <Trans>Saved.</Trans>
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-[12.5px] text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </Disclosure>
  );
}
