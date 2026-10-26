import {
  formatTaskRunTime,
  isTaskProgressActive,
  type TaskProgressBlock,
  type TaskProgressEntry,
  taskProgressCounts,
  taskProgressRunSeconds,
} from "@rakazo/contracts";
import { typeScale } from "@rakazo/ui-tokens";
import { useEffect, useState } from "react";
import type { PressableProps } from "react-native";
import { ActivityIndicator, Pressable, Text, useWindowDimensions, View } from "react-native";
import { chatCardShell } from "../lib/chat-card-shell";
import { useI18n } from "../lib/i18n";
import { threadCardWidth } from "../lib/message-presentation";
import { useMobileTokens } from "../lib/native";
import { NativeSymbol } from "./native-symbol";

type Tokens = ReturnType<typeof useMobileTokens>;
type Translate = ReturnType<typeof useI18n>["t"];

function stateLabel(entry: TaskProgressEntry, t: Translate): string {
  switch (entry.state) {
    case "queued":
      return entry.position
        ? t("queued #{position}", { position: String(entry.position) })
        : t("queued");
    case "starting":
      return t("starting");
    case "running":
      return t("running");
    case "needs_user":
      return t("needs you");
    case "stuck":
      return t("no progress");
    case "done":
      return t("done");
    case "failed":
      return t("failed");
    default:
      return t("cancelled");
  }
}

function stateColor(state: TaskProgressEntry["state"], tokens: Tokens): string {
  if (state === "done") return tokens.success;
  if (state === "failed") return tokens.destructive;
  if (state === "stuck" || state === "needs_user") return tokens.warning;
  if (state === "running") return tokens.foreground;
  return tokens.mutedForeground;
}

const STATE_SYMBOL: Record<
  Exclude<TaskProgressEntry["state"], "running">,
  { ios: string; android: Parameters<typeof NativeSymbol>[0]["android"] }
> = {
  queued: { ios: "clock", android: "time-outline" },
  starting: { ios: "clock.arrow.circlepath", android: "hourglass-outline" },
  needs_user: { ios: "hand.raised.fill", android: "hand-left-outline" },
  stuck: { ios: "exclamationmark.triangle.fill", android: "warning-outline" },
  done: { ios: "checkmark.circle.fill", android: "checkmark-circle" },
  failed: { ios: "xmark.circle.fill", android: "close-circle" },
  cancelled: { ios: "minus.circle", android: "remove-circle-outline" },
};

/** Running tasks spin (the platform's own indicator); every other state is a symbol. */
function StateIcon({ state, color }: { state: TaskProgressEntry["state"]; color: string }) {
  return (
    <View style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}>
      {state === "running" ? (
        <ActivityIndicator size="small" color={color} />
      ) : (
        <NativeSymbol {...STATE_SYMBOL[state]} size={17} color={color} />
      )}
    </View>
  );
}

type TaskProgressCardProps = {
  block: TaskProgressBlock;
  /** Long-press and accessibility actions from the message row. */
  pressableProps?: Omit<PressableProps, "onPress" | "style" | "children">;
  /** Tests and screenshots pin the clock. */
  now?: Date;
};

/**
 * The main chat's one card for background tasks: state, run time and latest step of each.
 * View-only: a row never opens its hidden worker's chat (long-press still reaches the message).
 */
export function TaskProgressCard({ block, pressableProps, now }: TaskProgressCardProps) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { width: windowWidth } = useWindowDimensions();
  const live =
    !now && !block.closed && block.tasks.some((task) => isTaskProgressActive(task.state));
  const [ticking, setTicking] = useState(() => new Date());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setTicking(new Date()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const clock = now ?? ticking;
  const { active, done, failed } = taskProgressCounts(block);
  const counts = [
    active ? t("{count} running", { count: String(active) }) : "",
    done ? t("{count} done", { count: String(done) }) : "",
    failed ? t("{count} not finished", { count: String(failed) }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View
      testID="task-progress-card"
      style={{
        // A fixed width like ChoiceCard and ComputerCard: in a content-sized bot row a
        // percentage resolves to nothing on iOS and Android, and the flexible title then
        // collapses the card to its icon column.
        width: threadCardWidth(windowWidth),
        ...chatCardShell(tokens),
        paddingHorizontal: 14,
        paddingTop: 12,
        paddingBottom: 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            backgroundColor: tokens.muted,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <NativeSymbol
            ios="square.stack.3d.up"
            android="layers-outline"
            size={19}
            color={tokens.mutedForeground}
          />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{ color: tokens.foreground, ...typeScale.secondary, fontWeight: "600" }}
          >
            {block.closed ? t("Background tasks finished") : t("Background tasks")}
          </Text>
          <Text
            numberOfLines={1}
            style={{ color: tokens.mutedForeground, ...typeScale.caption, marginTop: 1 }}
          >
            {counts}
          </Text>
        </View>
      </View>
      <View style={{ marginTop: 8 }}>
        {block.tasks.map((entry, index) => {
          const seconds = taskProgressRunSeconds(entry, clock);
          const label = stateLabel(entry, t);
          const color = stateColor(entry.state, tokens);
          return (
            <Pressable
              key={entry.ref}
              {...pressableProps}
              testID={`task-progress-${entry.ref}`}
              accessibilityRole="text"
              accessibilityLabel={`${entry.name} #${entry.ref}: ${label}`}
              style={{
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 12,
                paddingVertical: 10,
                paddingLeft: 9,
                borderTopWidth: index ? 1 : 0,
                borderTopColor: tokens.border,
              }}
            >
              <StateIcon state={entry.state} color={color} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text
                    numberOfLines={1}
                    style={{ flex: 1, color: tokens.foreground, ...typeScale.secondary }}
                  >
                    {entry.name} <Text style={{ color: tokens.mutedForeground }}>#{entry.ref}</Text>
                  </Text>
                  {seconds !== undefined ? (
                    <Text
                      style={{
                        color: tokens.mutedForeground,
                        ...typeScale.caption,
                        fontVariant: ["tabular-nums"],
                      }}
                    >
                      {formatTaskRunTime(seconds)}
                    </Text>
                  ) : null}
                </View>
                <Text numberOfLines={2} style={{ ...typeScale.caption, marginTop: 2 }}>
                  <Text style={{ color }}>{label}</Text>
                  {entry.step ? (
                    <Text style={{ color: tokens.mutedForeground }}> · {entry.step}</Text>
                  ) : null}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
