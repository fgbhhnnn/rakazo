/**
 * The acknowledgement a dispatcher keeps when it answered a request it also dispatched: whole
 * prose sentences only (never a heading, list line or a sentence cut in half), and a status line
 * built from the tool results whenever the prose does not name every task launched this turn.
 */

/** Longest acknowledgement taken from the model's own prose. */
export const ACK_KEEP_CHARS = 200;

export type LaunchedTask = {
  ref: string;
  name?: string;
  status: "started" | "queued";
  position?: number;
};

const TERMINAL = /[。！？!?]$/;
const NOT_PROSE = /^(?:#{1,6}\s|[-*+•]\s|\d+[.)、]\s?|\||>|```)/;

function plain(line: string): string {
  return line
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Complete prose sentences, in order; headings, list items, tables and "…：" lead-ins are skipped. */
export function proseSentences(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || NOT_PROSE.test(trimmed)) continue;
    // A line that is only emphasis (**…**) is a heading in disguise.
    if (/^(\*\*|__)[^*_]+\1[：:]?$/.test(trimmed)) continue;
    const line = plain(trimmed);
    for (const match of line.matchAll(/[^。！？!?]+[。！？!?]+|[^。！？!?]+$/g)) {
      const sentence = match[0].trim();
      if (!sentence || /[：:，,、；;]$/.test(sentence)) continue;
      out.push(TERMINAL.test(sentence) ? sentence : `${sentence}。`);
    }
  }
  return out;
}

function label(task: LaunchedTask): string {
  return task.name ? `「${task.name}」#${task.ref}` : `#${task.ref}`;
}

/** One status sentence for the tasks a turn launched, from the tool results. */
export function launchedTasksSummary(tasks: readonly LaunchedTask[]): string {
  const started = tasks.filter((task) => task.status === "started");
  const queued = tasks.filter((task) => task.status === "queued");
  const parts: string[] = [];
  if (started.length)
    parts.push(`已在后台开始 ${started.length} 个任务：${started.map(label).join("、")}`);
  if (queued.length) {
    const items = queued.map((task) =>
      task.position ? `${label(task)}（第 ${task.position} 位）` : label(task),
    );
    parts.push(`${queued.length} 个已排队，有空位会自动开始：${items.join("、")}`);
  }
  if (!parts.length) return "";
  return `${parts.join("；")}。完成后我会把结果发给你。`;
}

function covers(prose: string, tasks: readonly LaunchedTask[]): boolean {
  if (tasks.some((task) => !prose.includes(task.ref))) return false;
  return !tasks.some((task) => task.status === "queued") || /排队|queue/i.test(prose);
}

/**
 * At most two whole leading prose sentences within ACK_KEEP_CHARS; when they do not name every
 * launched task (and say which are queued), the status line from the tool results instead.
 */
export function acknowledgementOf(text: string, tasks: readonly LaunchedTask[] = []): string {
  let prose = "";
  let count = 0;
  for (const sentence of proseSentences(text)) {
    if (count >= 2 || prose.length + sentence.length > ACK_KEEP_CHARS) break;
    prose += sentence;
    count += 1;
  }
  if (!tasks.length || covers(prose, tasks))
    return prose || "收到，已安排后台处理，完成后我会把结果发给你。";
  return launchedTasksSummary(tasks);
}
