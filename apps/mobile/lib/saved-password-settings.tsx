import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { SettingsRow, SettingsSwitch } from "../components/settings-group";
import { rpc } from "./api";
import { useI18n } from "./i18n";
import { errorText } from "./user-error";

/** Uses the existing native switch; no new native modules are needed. */
export function SavedPasswordSettings() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const version = useRef(0);
  useFocusEffect(
    useCallback(() => {
      if (saving.current) return;
      const readVersion = version.current;
      let live = true;
      void rpc("savedPasswordSettings/get")
        .then((settings) => {
          if (live && version.current === readVersion) setEnabled(settings.allowBotPasswordReveal);
        })
        .catch((cause) => {
          if (live) setError(errorText(cause, t("Something went wrong. Try again.")));
        });
      return () => {
        live = false;
      };
    }, [t]),
  );
  async function save(value: boolean) {
    if (saving.current || enabled === null) return;
    saving.current = true;
    version.current += 1;
    setPending(true);
    setError(null);
    try {
      const settings = await rpc("savedPasswordSettings/update", { allowBotPasswordReveal: value });
      setEnabled(settings.allowBotPasswordReveal);
    } catch (cause) {
      setError(errorText(cause, t("Something went wrong. Try again.")));
    } finally {
      saving.current = false;
      setPending(false);
    }
  }
  return (
    <>
      <SettingsSwitch
        label={t("Allow bots to use saved passwords directly")}
        detail={t(
          "Passwords go to your model provider and may appear in history. Enable only if needed.",
        )}
        value={enabled === true}
        disabled={enabled === null || pending}
        onChange={(value) => void save(value)}
      />
      {error ? <SettingsRow title={error} /> : null}
    </>
  );
}
