import { Trans, useLingui } from "@lingui/react/macro";
import { Label, Switch } from "@rakazo/ui-web";
import { Disclosure } from "@rakazo/ui-web/components/ui/disclosure";
import { useEffect, useId, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { SettingsRow } from "./SettingsRows";

export function SavedPasswordSettings() {
  const { t } = useLingui();
  const id = useId();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => rpc.savedPasswordSettings.get())
      .then((settings) => {
        if (live) setEnabled(settings.allowBotPasswordReveal);
      })
      .catch((cause) => {
        if (live) setError(errorText(cause));
      });
    return () => {
      live = false;
    };
  }, []);
  async function save(value: boolean) {
    if (saving.current || enabled === null) return;
    saving.current = true;
    setPending(true);
    setError(null);
    try {
      const settings = await rpc.savedPasswordSettings.update({ allowBotPasswordReveal: value });
      setEnabled(settings.allowBotPasswordReveal);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      saving.current = false;
      setPending(false);
    }
  }
  return (
    <Disclosure
      summary={<Trans>Advanced</Trans>}
      className="rounded-xl border border-border"
      summaryClassName="flex w-full items-center justify-between px-4 py-4 text-sm"
    >
      <SettingsRow
        label={
          <Label htmlFor={id} className="font-normal">
            <Trans>Allow bots to use saved passwords directly</Trans>
          </Label>
        }
        control={
          <Switch
            id={id}
            aria-describedby={`${id}-warning`}
            checked={enabled === true}
            disabled={enabled === null || pending}
            onCheckedChange={(value) => void save(value)}
            aria-label={t`Allow bots to use saved passwords directly`}
          />
        }
      >
        <p id={`${id}-warning`} className="mt-2 text-sm text-muted-foreground">
          <Trans>
            Passwords go to your model provider and may appear in history. Enable only if needed.
          </Trans>
        </p>
        {error ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsRow>
    </Disclosure>
  );
}
