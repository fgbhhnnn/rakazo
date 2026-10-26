import { cjkChars, isCjkText, spokenMemory } from "./echo.js";

/** Lower echo match while audio plays: most of what the mic hears is the speaker. */
const PLAYBACK_ECHO_RATIO = 0.4;
/** The only one-word turns worth cutting a reply short for. */
const INTERRUPT_WORDS = new Set([
  "stop",
  "wait",
  "hold on",
  "pause",
  "no",
  "停",
  "停下",
  "等等",
  "等一下",
  "暂停",
  "别说了",
  "不对",
]);
/** CJK has no spaces: this many characters stand in for "more than one word". */
const MIN_CJK_BARGE_IN_CHARS = 4;

/**
 * How long an interim phrase must stand before it cuts playback.
 * The final transcript arrives later, after the reply has already finished.
 */
export const INTERIM_BARGE_IN_MS = 300;

/** A sentence, or one interruption word, that is not the reply leaking back into the mic. */
export function isCallBargeIn(text: string): boolean {
  if (spokenMemory.isEcho(recentPart(text), PLAYBACK_ECHO_RATIO)) return false;
  const cleaned = cleanWords(text);
  if (isCjkText(text)) {
    return INTERRUPT_WORDS.has(cleaned.replace(/\s+/g, "")) || isLongCjkTurn(text);
  }
  return cleaned.includes(" ") || INTERRUPT_WORDS.has(cleaned);
}

/** An interim is revised word by word, so one stray word never cuts playback. */
export function isInterimCallBargeIn(text: string): boolean {
  const longEnough = isCjkText(text) ? isLongCjkTurn(text) : cleanWords(text).includes(" ");
  return longEnough && !spokenMemory.isEcho(recentPart(text), PLAYBACK_ECHO_RATIO);
}

/** Recognizer text a session has grown while the reply played; past this it stops matching as echo. */
const RECENT_CJK_CHARS = 12;
const RECENT_WORDS = 6;

/**
 * The newest stretch of a transcript. A recognizer left open over a long reply keeps
 * appending the speaker to one line, and a whole line that long never counts as echo;
 * the caller talking over it shows up at the end, so judge the end.
 */
function recentPart(text: string): string {
  if (isCjkText(text)) return cjkChars(text).slice(-RECENT_CJK_CHARS);
  return cleanWords(text).split(" ").slice(-RECENT_WORDS).join(" ");
}

function isLongCjkTurn(text: string): boolean {
  return cjkChars(text).length >= MIN_CJK_BARGE_IN_CHARS;
}

function cleanWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Counts down an interim phrase heard over a reply: one that stands for
 * INTERIM_BARGE_IN_MS calls `onBargeIn`, and anything that no longer qualifies resets it.
 */
export function createInterimBargeIn(onBargeIn: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    hear(text: string): void {
      if (!isInterimCallBargeIn(text)) {
        clear();
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        onBargeIn();
      }, INTERIM_BARGE_IN_MS);
    },
    clear,
  };
}
