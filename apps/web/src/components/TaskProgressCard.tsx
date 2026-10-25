import { Trans } from "@lingui/react/macro";
import {
  formatTaskRunTime,
  isTaskProgressActive,
  type TaskProgressBlock,
  type TaskProgressEntry,
  taskProgressCounts,
  taskProgressRunSeconds,
} from "@rakazo/contracts";
import { Badge } from "@rakazo/ui-web/components/ui/badge";
import { Card, CardContent } from "@rakazo/ui-web/components/ui/card";
import { useEffect, useState } from "react";

const STATE_TONE: Record<TaskProgressEntry["state"], string> = {
  queued: "text-muted-foreground",
  starting: "text-muted-foreground",
  running: "text-foreground",
  needs_user: "text-warning",
  stuck: "text-warning",
  done: "text-success",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
};

function StateLabel({ entry }: { entry: TaskProgressEntry }) {
  switch (entry.state) {
    case "queued":
      return entry.position ? <Trans>queued #{entry.position}</Trans> : <Trans>queued</Trans>;
    case "starting":
      return <Trans>starting</Trans>;
    case "running":
      return <Trans>running</Trans>;
    case "needs_user":
      return <Trans>needs you</Trans>;
    case "stuck":
      return <Trans>no progress</Trans>;
    case "done":
      return <Trans>done</Trans>;
    case "failed":
      return <Trans>failed</Trans>;
    default:
      return <Trans>cancelled</Trans>;
  }
}

/** Ticks once a second while any task on the card still runs; run times count up locally. */
function useNow(live: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

export function TaskProgressCard({
  block,
  onOpenBot,
  now: fixedNow,
}: {
  block: TaskProgressBlock;
  onOpenBot?: (botId: string) => void;
  /** Tests and screenshots pin the clock. */
  now?: Date;
}) {
  const live = !block.closed && block.tasks.some((task) => isTaskProgressActive(task.state));
  const ticking = useNow(live && !fixedNow);
  const now = fixedNow ?? ticking;
  const { active, done, failed } = taskProgressCounts(block);
  return (
    <Card size="sm" className="w-[26rem] max-w-full" data-testid="task-progress-card">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="font-medium">
            {block.closed ? (
              <Trans>Background tasks finished</Trans>
            ) : (
              <Trans>Background tasks</Trans>
            )}
          </span>
          <span className="text-muted-foreground text-sm" data-testid="task-progress-counts">
            {active ? <Trans>{active} running</Trans> : null}
            {active && (done || failed) ? " · " : null}
            {done ? <Trans>{done} done</Trans> : null}
            {done && failed ? " · " : null}
            {failed ? <Trans>{failed} not finished</Trans> : null}
          </span>
        </div>
        <ul className="flex flex-col divide-y divide-border">
          {block.tasks.map((entry) => {
            const seconds = taskProgressRunSeconds(entry, now);
            const open = entry.workerBotId && onOpenBot ? entry.workerBotId : undefined;
            const row = (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-medium text-sm" dir="auto">
                    {entry.name}{" "}
                    <span className="font-normal text-muted-foreground">#{entry.ref}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {seconds !== undefined ? (
                      <span
                        className="text-muted-foreground text-xs tabular-nums"
                        data-testid="task-progress-time"
                      >
                        {formatTaskRunTime(seconds)}
                      </span>
                    ) : null}
                    <Badge variant="secondary" className={STATE_TONE[entry.state]}>
                      <StateLabel entry={entry} />
                    </Badge>
                  </span>
                </div>
                {entry.step ? (
                  <span
                    className="line-clamp-2 text-muted-foreground text-xs"
                    dir="auto"
                    data-testid="task-progress-step"
                  >
                    {entry.step}
                  </span>
                ) : null}
              </>
            );
            return (
              <li key={entry.ref} data-state={entry.state} className="py-1.5">
                {open ? (
                  <button
                    type="button"
                    className="flex w-full flex-col gap-0.5 text-start hover:opacity-80"
                    onClick={() => onOpenBot?.(open)}
                  >
                    {row}
                  </button>
                ) : (
                  <div className="flex flex-col gap-0.5">{row}</div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
