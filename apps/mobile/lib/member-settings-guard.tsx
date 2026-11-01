import { type ComponentType, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { rpc } from "./api";
import { useI18n } from "./i18n";
import { queryClient } from "./query";

/** The last answer, in the query cache so sign-out (which clears it) forgets it too. */
const LOCK_KEY = ["member-settings-locked"] as const;

/**
 * Hides a settings screen the deployment owner manages; the server rejects its writes anyway.
 * A revisit decides from the last answer at once, so the screen still paints from its own
 * cache, and the fresh profile replaces that answer when it arrives.
 */
export function withMemberSettingsGuard(Screen: ComponentType) {
  return function MemberSettingsGuard() {
    const { t } = useI18n();
    const [locked, setLocked] = useState<boolean | null>(
      () => queryClient.getQueryData<boolean>(LOCK_KEY) ?? null,
    );
    useEffect(() => {
      let live = true;
      const settle = (value: boolean) => {
        queryClient.setQueryData(LOCK_KEY, value);
        if (live) setLocked(value);
      };
      void rpc("me")
        .then((me) => settle(me.memberSettingsLocked === true))
        .catch(() => settle(false));
      return () => {
        live = false;
      };
    }, []);
    if (locked === null) return null;
    if (!locked) return <Screen />;
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Text style={{ textAlign: "center", opacity: 0.7 }}>
          {t("Your administrator manages this setting.")}
        </Text>
      </View>
    );
  };
}
