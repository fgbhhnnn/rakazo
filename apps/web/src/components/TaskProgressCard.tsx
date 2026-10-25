import { Trans } from "@lingui/react/macro";
import {
  formatTaskRunTime,
  isTaskProgressActive,
  type TaskProgressBlock,
  type TaskProgressEntry,
  taskProgressCounts,
  taskProgressRunSeconds,
} from "@rakazo/contracts";
import {
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  Hand,
  History,
  Layers,
  LoaderCircle,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";

const STATE_ICON: Record<TaskProgressEntry["state"], LucideIcon> = {
  queued: Clock,
  starting: History,
  running: LoaderCircle,
  needs_user: Hand,
  stuck: TriangleAlert,
  done: CircleCheck,
  failed: CircleX,
  cancelled: CircleMinus,
};

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

/** View-only: a task's row never opens its hidden worker's chat. */
export function TaskProgressCard({
  block,
  now: fixedNow,
}: {
  block: TaskProgressBlock;
  /** Tests and screenshots pin the clock. */
  now?: Date;
}) {
  const live = !block.closed && block.tasks.some((task) => isTaskProgressActive(task.state));
  const ticking = useNow(live && !fixedNow);
  const now = fixedNow ?? ticking;
  const { active, done, failed } = taskProgressCounts(block);
  return (
    <div
      className="w-[min(440px,100%)] min-w-[280px] rounded-2xl border border-border bg-card px-4 pt-3.5 pb-1.5 text-foreground"
      data-testid="task-progress-card"
    >
      <div className="flex items-center gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
          <Layers size={19} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] leading-5 font-semibold">
            {block.closed ? (
              <Trans>Background tasks finished</Trans>
            ) : (
              <Trans>Background tasks</Trans>
            )}
          </span>
          <span
            className="mt-0.5 block truncate text-[13px] leading-5 text-muted-foreground"
            data-testid="task-progress-counts"
          >
            {active ? <Trans>{active} running</Trans> : null}
            {active && (done || failed) ? " · " : null}
            {done ? <Trans>{done} done</Trans> : null}
            {done && failed ? " · " : null}
            {failed ? <Trans>{failed} not finished</Trans> : null}
          </span>
        </span>
      </div>
      <ul className="mt-2 flex flex-col divide-y divide-border">
        {block.tasks.map((entry) => {
          const seconds = taskProgressRunSeconds(entry, now);
          const Icon = STATE_ICON[entry.state];
          const row = (
            <>
              <Icon
                size={17}
                strokeWidth={1.9}
                aria-hidden="true"
                className={`mt-0.5 shrink-0 ${STATE_TONE[entry.state]} ${entry.state === "running" ? "animate-spin" : ""}`}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[14px] leading-5" dir="auto">
                    {entry.name} <span className="text-muted-foreground">#{entry.ref}</span>
                  </span>
                  {seconds !== undefined ? (
                    <span
                      className="shrink-0 text-[12.5px] text-muted-foreground tabular-nums"
                      data-testid="task-progress-time"
                    >
                      {formatTaskRunTime(seconds)}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-[18px]" dir="auto">
                  <span className={STATE_TONE[entry.state]}>
                    <StateLabel entry={entry} />
                  </span>
                  {entry.step ? (
                    <span className="text-muted-foreground" data-testid="task-progress-step">
                      {" · "}
                      {entry.step}
                    </span>
                  ) : null}
                </span>
              </span>
            </>
          );
          return (
            <li key={entry.ref} data-state={entry.state}>
              <div className="flex items-start gap-3 py-2.5">{row}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
