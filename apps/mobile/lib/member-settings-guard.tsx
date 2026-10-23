import { type ComponentType, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { type MobileMe, rpc } from "./api";
import { useI18n } from "./i18n";

/** Hides a settings screen the deployment owner manages; the server rejects its writes anyway. */
export function withMemberSettingsGuard(Screen: ComponentType) {
  return function MemberSettingsGuard() {
    const { t } = useI18n();
    const [locked, setLocked] = useState<boolean | null>(null);
    useEffect(() => {
      let live = true;
      void rpc<MobileMe>("me")
        .then((me) => live && setLocked(me.memberSettingsLocked === true))
        .catch(() => live && setLocked(false));
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
