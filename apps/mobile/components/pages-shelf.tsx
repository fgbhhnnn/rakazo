import type { PageSummary } from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import { listPages } from "../lib/pages";
import { PageCard } from "./page-card";

const SHELF_LIMIT = 30;

/** The reports and plans bots wrote as pages, newest first; hidden when there are none. */
export function PagesShelf({ botId }: { botId?: string }) {
  const { t } = useI18n();
  const [pages, setPages] = useState<PageSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    setPages([]);
    void listPages({ botId, limit: SHELF_LIMIT })
      .then((items) => {
        if (!cancelled) setPages(items);
      })
      // The artifact list below still shows every page's markdown file.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [botId]);

  if (pages.length === 0) return null;
  return (
    <View style={{ paddingBottom: 12 }}>
      <Text
        accessibilityRole="header"
        style={{
          color: native.secondaryLabel,
          ...typeScale.footnote,
          fontWeight: "600",
          paddingHorizontal: 4,
          paddingBottom: 8,
        }}
      >
        {t("Pages")}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ gap: 10 }}
      >
        {pages.map((page) => (
          <PageCard
            key={page.id}
            pageId={page.id}
            title={page.title}
            snippet={page.snippet}
            width={260}
          />
        ))}
      </ScrollView>
    </View>
  );
}
