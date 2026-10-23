import type { Message } from "@earendil-works/pi-ai";

type ToolResultMessage = Extract<Message, { role: "toolResult" }>;

const DEFAULT_COMPUTER_SCREENSHOTS_TO_KEEP = 2;

/**
 * Tools whose result is a view of the current page or screen. Each new result supersedes the
 * earlier ones, so older results only cost context: a long browsing run otherwise re-sends every
 * snapshot it ever took on every model call.
 */
const PAGE_STATE_TOOL_NAMES = new Set([
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "computer_observe",
  "computer_act",
]);
const DEFAULT_PAGE_STATE_RESULTS_TO_KEEP = 3;
/**
 * Only results that actually carry a page (a snapshot tree, an observation) are worth trimming
 * or counting. Navigation confirmations, action receipts and errors are a line or two: trimming
 * them saves nothing, and counting them would push real page state out of the kept set.
 */
const STALE_PAGE_STATE_MIN_CHARS = 1_000;
const STALE_PAGE_STATE_NOTE =
  "[Earlier page state trimmed to save context. Facts you still need from that page should already be in your notes or tracker; otherwise take a fresh snapshot.]";

/**
 * Replace all but the most recent large page-state tool results with a short note. The runtime
 * context policy applies this only when it rebuilds a run's transcript, never to a transcript the
 * model has already seen.
 */
export function pruneStalePageStateContext(
  messages: Message[],
  keep = DEFAULT_PAGE_STATE_RESULTS_TO_KEEP,
): Message[] {
  let remaining = Math.max(0, Math.floor(keep));
  let transformed: Message[] | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "toolResult" || !PAGE_STATE_TOOL_NAMES.has(message.toolName)) continue;
    // Failures are diagnostics, not fresh page state, even when their text is large.
    const returnedError = (message.details as { error?: unknown } | undefined)?.error;
    if (message.isError || (returnedError !== undefined && returnedError !== null)) continue;
    if (textLength(message) < STALE_PAGE_STATE_MIN_CHARS) continue;
    if (remaining > 0) {
      remaining -= 1;
      continue;
    }
    transformed ??= [...messages];
    transformed[index] = {
      ...message,
      content: [{ type: "text", text: STALE_PAGE_STATE_NOTE }],
    };
  }
  return transformed ?? messages;
}

function textLength(message: ToolResultMessage): number {
  let total = 0;
  for (const part of message.content) {
    if (part.type === "text") total += part.text.length;
  }
  return total;
}

/**
 * Keep the latest screenshots within an optional model image budget. The runtime context policy
 * applies this only when it rebuilds a run's transcript; between rebuilds screenshots accumulate
 * up to the model's limit, so a rebuild keeps at most the default two to leave room for more.
 */
export function pruneComputerScreenshotContext(
  messages: Message[],
  maxImagesPerPrompt?: number,
): Message[] {
  const imageLimit = normalizedImageLimit(maxImagesPerPrompt);
  let remaining = DEFAULT_COMPUTER_SCREENSHOTS_TO_KEEP;
  if (imageLimit !== undefined) {
    const nonScreenshotImages = messages.reduce(
      (count, message) =>
        isComputerScreenshotMessage(message) ? count : count + imagePartCount(message),
      0,
    );
    if (nonScreenshotImages > imageLimit) {
      throw new Error(
        `The configured model image limit is ${imageLimit}, but the prompt contains ${nonScreenshotImages} non-screenshot images.`,
      );
    }
    remaining = Math.min(remaining, imageLimit - nonScreenshotImages);
  }
  let transformed: Message[] | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isComputerScreenshotMessage(message)) continue;
    const images = imagePartCount(message);
    if (remaining >= images) {
      remaining -= images;
      continue;
    }
    transformed ??= [...messages];
    transformed[index] = {
      ...message,
      content: message.content.filter((part) => part.type !== "image"),
    };
  }
  return transformed ?? messages;
}

/** What a rebuild drops: stale page state, and screenshots over the default or model limit. */
export function pruneForRebuild(messages: Message[], maxImagesPerPrompt?: number): Message[] {
  const capped = capToolResultImages(
    pruneStalePageStateContext(messages),
    toolImageLimit(maxImagesPerPrompt),
  );
  return pruneComputerScreenshotContext(capped, maxImagesPerPrompt);
}

/** A model's image limit as a whole number, or undefined when it has none or it isn't finite. */
export function normalizedImageLimit(maxImagesPerPrompt?: number): number | undefined {
  if (maxImagesPerPrompt === undefined || !Number.isFinite(maxImagesPerPrompt)) return undefined;
  return Math.max(0, Math.floor(maxImagesPerPrompt));
}

export function imagePartCount(message: Message): number {
  if (!Array.isArray(message.content)) return 0;
  return (message.content as Array<{ type: string }>).filter((part) => part.type === "image")
    .length;
}

function isComputerScreenshotMessage(message: Message | undefined): message is ToolResultMessage {
  if (message?.role !== "toolResult" || !message.content.some((part) => part.type === "image")) {
    return false;
  }
  const details = message.details;
  return Boolean(
    details &&
      typeof details === "object" &&
      "frameId" in details &&
      typeof (details as { frameId?: unknown }).frameId === "string",
  );
}

/** Images a request may carry before the oldest tool-result images are swapped for a note. */
export const DEFAULT_MAX_TOOL_IMAGES = 8;
/** How many images survive after a provider rejected an image-heavy request. */
export const OVERFLOW_RETRY_MAX_IMAGES = 2;

/**
 * The image budget for tool results: the connection's limit when set, otherwise
 * RAKAZO_MAX_TOOL_IMAGES or the default, whichever is tighter.
 */
export function toolImageLimit(
  maxImagesPerPrompt?: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.RAKAZO_MAX_TOOL_IMAGES?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  const fallback = Number.isFinite(parsed)
    ? Math.max(0, Math.floor(parsed))
    : DEFAULT_MAX_TOOL_IMAGES;
  const configured = normalizedImageLimit(maxImagesPerPrompt);
  return configured === undefined ? fallback : Math.min(configured, fallback);
}

function removedImageNote(message: ToolResultMessage): string {
  const details = message.details as Record<string, unknown> | undefined;
  const path = ["path", "file", "filePath", "url"]
    .map((key) => details?.[key])
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const label = [message.toolName, path].filter(Boolean).join(" ");
  return `[earlier image removed to save context${label ? `: ${label}` : ""}. Re-open the file if you still need it.]`;
}

/**
 * Keep a request within `limit` images by replacing the oldest tool-result images with a short
 * text note. User images are never removed (they are what the user asked about); only tool
 * results, oldest first, so the newest views stay visible. Returns the input when nothing changes.
 */
export function capToolResultImages(messages: Message[], limit: number): Message[] {
  const max = Math.max(0, Math.floor(limit));
  let excess = messages.reduce((count, message) => count + imagePartCount(message), 0) - max;
  if (excess <= 0) return messages;
  let transformed: Message[] | undefined;
  for (let index = 0; index < messages.length && excess > 0; index += 1) {
    const message = messages[index];
    if (message?.role !== "toolResult" || imagePartCount(message) === 0) continue;
    const content: ToolResultMessage["content"] = [];
    let noted = false;
    for (const part of message.content) {
      if (part.type === "image" && excess > 0) {
        excess -= 1;
        if (!noted) {
          content.push({ type: "text", text: removedImageNote(message) });
          noted = true;
        }
        continue;
      }
      content.push(part);
    }
    transformed ??= [...messages];
    transformed[index] = { ...message, content };
  }
  return transformed ?? messages;
}

/** Index of the first message `capToolResultImages` changed, or -1. */
export function firstChangedIndex(before: Message[], after: Message[]): number {
  if (before === after) return -1;
  return after.findIndex((message, index) => message !== before[index]);
}

/**
 * Whether a provider error looks like the request was too big: too many/too large images or
 * an over-long context, on a request with more images than the retry keeps. A bare "Upstream error: 400" from a gateway counts only when the request
 * actually carried more images than the overflow retry keeps.
 */
export function looksLikeContextOverflow(
  errorMessage: string | undefined,
  imageCount: number,
): boolean {
  // Shrinking images is the only remedy this retry has, so text-only overflow is left alone.
  if (imageCount <= OVERFLOW_RETRY_MAX_IMAGES) return false;
  const message = errorMessage ?? "";
  if (
    /context.{0,20}(length|window|too long)|too many (images|tokens)|maximum context|prompt is too long|image.{0,40}(limit|too large|exceed|too many)|request (entity )?too large|payload too large|\b413\b/i.test(
      message,
    )
  )
    return true;
  return (
    imageCount > OVERFLOW_RETRY_MAX_IMAGES &&
    /\b400\b/.test(message) &&
    /upstream|invalid_request/i.test(message)
  );
}
