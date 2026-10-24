import { runContinueJob } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { getLogger } from "@rakazo/logging";
import { acknowledgementOf, type LaunchedTask } from "./dispatch-acknowledgement.js";
import type { ExecutorDeps } from "./executor.js";
import { withoutWorkerSlotMentions } from "./worker-slot-mentions.js";

export { acknowledgementOf } from "./dispatch-acknowledgement.js";

/** Longest reply a dispatcher may write in a turn that started new work (the acknowledgement). */
export const DISPATCH_ACK_MAX_CHARS = 400;
/** Marks a corrective turn's prompt, so a turn is re-prompted at most once. */
export const CLAIM_RECHECK_MARKER = "【系统核对：上一轮回复声称已安排后台任务】";

const ok = (result: unknown): result is Record<string, unknown> =>
  Boolean(result) && typeof result === "object" && !("error" in (result as object));

/**
 * What a dispatcher turn actually did with its background_task* tools, recorded as tool calls
 * return, so the final reply can be checked against it.
 */
export function createDispatcherTurnLedger() {
  const launchedRefs = new Set<string>();
  const launchedTasks: LaunchedTask[] = [];
  let launched = 0;
  let acted = 0;
  return {
    record(name: string, result: unknown) {
      if (!ok(result) || !name.startsWith("background_task")) return;
      acted += 1;
      if (name === "background_task") {
        const status = result.status;
        if (status === "started" || status === "queued") {
          launched += 1;
          for (const key of ["task_ref", "task_id"]) {
            if (typeof result[key] === "string") launchedRefs.add(String(result[key]));
          }
          const ref = result.task_ref ?? result.task_id;
          if (typeof ref === "string") {
            launchedTasks.push({
              ref,
              status,
              name: typeof result.name === "string" ? result.name : undefined,
              position: typeof result.position === "number" ? result.position : undefined,
            });
          }
        }
      }
    },
    /** A new task was started or queued this turn. */
    get launchedNew() {
      return launched > 0;
    },
    /** Some background_task* tool call succeeded this turn. */
    get actedOnWorkers() {
      return acted > 0;
    },
    launchedRefs: launchedRefs as ReadonlySet<string>,
    /** The tasks started or queued this turn, as their tool results reported them. */
    launchedTasks: launchedTasks as readonly LaunchedTask[],
  };
}
export type DispatcherTurnLedger = ReturnType<typeof createDispatcherTurnLedger>;

// Generic shapes of "a worker was asked / started / re-sent", not a list of exact phrases: a
// done-marker (我/已经/刚/这就/马上/正在) + asking verb + the worker; done-marker + arranged /
// dispatched / started / handed over; "opened a background (task)"; done-marker + re-send.
const WORKER = "(?:它|他|她|后台|worker|工作者|那个任务|该任务|任务)";
const DONE = "(?:我|已经?|刚刚?|这就|马上|正在|现在)";
const CLAIM_PATTERNS: readonly RegExp[] = [
  new RegExp(`${DONE}[^。！？!?\\n]{0,6}(?:让|叫|请|要求|通知|告诉)${WORKER}`, "i"),
  /(?:已经?|刚刚?)(?:经)?(?:安排|派发?|启动|开启|开了|发起|提交|交给|转给|转交)/,
  /开(?:了|启了?)?(?:一个|个)?(?:新的?)?后台/,
  new RegExp(`${DONE}[^。！？!?\\n]{0,8}(?:补发|重发|重新发)`),
  /\bI(?:'ve| have| just|'ll| will)?\s+(?:asked|told|started|launched|dispatched|queued|re-?sent|handed)\b[^.!?\n]{0,40}\b(?:worker|background|task|it)\b/i,
];
// Offers and questions ("要不要我让它重发？") are not claims.
const QUESTION = /[？?]\s*$|吗[。！!]?\s*$|要不要|是否|需不需要|可以让/;

function isClaimSentence(sentence: string): boolean {
  return (
    !QUESTION.test(sentence.trim()) && CLAIM_PATTERNS.some((pattern) => pattern.test(sentence))
  );
}

export function claimsWorkerAction(text: string): boolean {
  return sentences(text).some(isClaimSentence);
}

const SENTENCE = /[^。！？!?\n]+[。！？!?]*\s*|\n+/g;

function sentences(text: string): string[] {
  return text.match(SENTENCE) ?? [];
}

/** Drops the sentences that claim a worker action; keeps the rest of the reply as written. */
export function withoutWorkerClaims(text: string): string {
  return sentences(text)
    .filter((sentence) => !isClaimSentence(sentence))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A reply that relays work other than this turn's new tasks: a worker result or another #ref. */
function relaysOtherWork(text: string, launchedRefs: ReadonlySet<string>): boolean {
  if (/【后台任务[:：]/.test(text)) return true;
  for (const match of text.matchAll(/#([A-Za-z0-9]{6,12})\b/g)) {
    if (!launchedRefs.has(match[1]!)) return true;
  }
  return false;
}

export type ReplyGuardOutcome = {
  blocks: MessageBlock[];
  changed: boolean;
  /** The reply claimed a worker action no tool performed: queue one corrective turn. */
  recheckClaim: boolean;
  /** The original reply text, for the corrective prompt. */
  original?: string;
};

/**
 * Post-turn checks on a dispatcher's final reply:
 * - a turn that started new work replies with a short acknowledgement only, not the answer
 *   (unless it also relays a worker result or another task, or was woken by one);
 * - a reply that says a worker was asked/started/re-sent when no background_task* call
 *   succeeded loses that claim, and the turn is re-prompted once to actually do it;
 * - worker slot names ("由后台4执行") are removed: tasks are named by title and #REF.
 */
export function guardDispatcherReply(
  enabled: boolean,
  blocks: MessageBlock[],
  ledger: DispatcherTurnLedger,
  context: { wokenByWorker: boolean; runId: string },
): ReplyGuardOutcome {
  if (!enabled) return { blocks, changed: false, recheckClaim: false };
  const text = blocks
    .flatMap((block) => (block.kind === "text" ? [block.text] : []))
    .join("")
    .trim();
  if (!text) return { blocks, changed: false, recheckClaim: false };
  let next = text;
  let recheckClaim = false;
  if (!ledger.actedOnWorkers && !context.wokenByWorker && claimsWorkerAction(text)) {
    getLogger().warn("dispatcher reply claims a worker action no tool performed", {
      runId: context.runId,
    });
    next = withoutWorkerClaims(text) || "收到。";
    recheckClaim = true;
  } else if (
    ledger.launchedNew &&
    !context.wokenByWorker &&
    text.length > DISPATCH_ACK_MAX_CHARS &&
    !relaysOtherWork(text, ledger.launchedRefs)
  ) {
    getLogger().warn("dispatcher answered a request it dispatched; keeping the acknowledgement", {
      runId: context.runId,
      chars: text.length,
    });
    next = acknowledgementOf(text, ledger.launchedTasks);
  }
  next = withoutWorkerSlotMentions(next);
  if (next === text) return { blocks, changed: false, recheckClaim };
  let placed = false;
  const out: MessageBlock[] = [];
  for (const block of blocks) {
    if (block.kind !== "text") {
      out.push(block);
      continue;
    }
    if (placed) continue;
    placed = true;
    out.push({ ...block, text: next });
  }
  return { blocks: out, changed: true, recheckClaim, original: text };
}

/**
 * The single corrective turn after a false claim: same trigger and source message, the original
 * request plus a note to really call the tool (or correct itself). Skipped when a continuation
 * already answers newer messages. Returns whether a turn was queued.
 */
export async function queueClaimRecheck(
  deps: Pick<ExecutorDeps, "prisma" | "jobs">,
  run: {
    id: string;
    spaceId: string;
    botId: string;
    threadId: string;
    taskId: string;
    userId: string;
    trigger: string;
    sourceMessageId: string | null;
  },
  claimText: string,
): Promise<boolean> {
  const task = await deps.prisma.task.findUnique({
    where: { id: run.taskId },
    select: { prompt: true },
  });
  if (!task || task.prompt.includes(CLAIM_RECHECK_MARKER)) return false;
  const note = `${CLAIM_RECHECK_MARKER}\n你上一轮回复说已经让后台去做某件事（"${claimText.slice(0, 200)}"），但那一轮没有调用 background_task 或 background_task_message，所以其实什么也没发生。现在就用工具真正去做；如果其实不需要做，就简短向用户更正。不要再声称做了没做的事。`;
  const created = await deps.prisma.$transaction(async (tx) => {
    const retryTask = await tx.task.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        userId: run.userId,
        prompt: `${task.prompt}\n\n${note}`,
        status: "queued",
      },
    });
    return tx.run.create({
      data: {
        spaceId: run.spaceId,
        botId: run.botId,
        threadId: run.threadId,
        taskId: retryTask.id,
        userId: run.userId,
        status: "queued",
        trigger: run.trigger,
        sourceMessageId: run.sourceMessageId,
        retryOfRunId: run.id,
      },
      select: { id: true },
    });
  });
  await deps.jobs.enqueue(runContinueJob(created.id));
  return true;
}
