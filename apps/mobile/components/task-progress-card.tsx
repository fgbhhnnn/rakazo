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
import { Pressable, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

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

type TaskProgressCardProps = {
  block: TaskProgressBlock;
  /** Opens a task's worker chat; the task's name stands in when the worker is not listed. */
  onOpenBot?: (botId: string, taskName: string) => void;
  /** Long-press and accessibility actions from the message row. */
  pressableProps?: Omit<PressableProps, "onPress" | "style" | "children">;
  /** Tests and screenshots pin the clock. */
  now?: Date;
};

/** The main chat's one card for background tasks: state, run time and latest step of each. */
export function TaskProgressCard({ block, onOpenBot, pressableProps, now }: TaskProgressCardProps) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
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
        width: "90%",
        borderRadius: 18,
        backgroundColor: tokens.card,
        paddingHorizontal: 16,
        paddingVertical: 12,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ flexShrink: 1, color: tokens.cardForeground, ...typeScale.cardTitle }}>
          {block.closed ? t("Background tasks finished") : t("Background tasks")}
        </Text>
        <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>{counts}</Text>
      </View>
      {block.tasks.map((entry, index) => {
        const seconds = taskProgressRunSeconds(entry, clock);
        const label = stateLabel(entry, t);
        const workerBotId = entry.workerBotId;
        return (
          <Pressable
            key={entry.ref}
            {...pressableProps}
            testID={`task-progress-${entry.ref}`}
            accessibilityRole={workerBotId && onOpenBot ? "button" : "text"}
            accessibilityLabel={`${entry.name} #${entry.ref}: ${label}`}
            disabled={!workerBotId || !onOpenBot}
            onPress={() => {
              if (workerBotId) onOpenBot?.(workerBotId, entry.name);
            }}
            style={({ pressed }) => ({
              opacity: pressed ? 0.6 : 1,
              paddingVertical: 8,
              borderTopWidth: index ? 1 : 0,
              borderTopColor: tokens.border,
              marginTop: index ? 0 : 6,
            })}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text
                numberOfLines={1}
                style={{
                  flex: 1,
                  color: tokens.foreground,
                  ...typeScale.secondary,
                  fontWeight: "600",
                }}
              >
                {entry.name}{" "}
                <Text style={{ color: tokens.mutedForeground, fontWeight: "400" }}>
                  #{entry.ref}
                </Text>
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
              <Text style={{ color: stateColor(entry.state, tokens), ...typeScale.caption }}>
                {label}
              </Text>
            </View>
            {entry.step ? (
              <Text
                numberOfLines={2}
                style={{ color: tokens.mutedForeground, ...typeScale.caption, marginTop: 2 }}
              >
                {entry.step}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
