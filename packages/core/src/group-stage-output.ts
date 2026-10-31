/**
 * A group stage that ends with only "done" (已完成 / 写完了 / done) and nothing to show for it is
 * not finished: whoever takes the result next (the leader, the user) cannot check or use it. Such
 * a reply gets one prompt to post the actual output before the stage moves on.
 */

const DONE =
  /(完成|写完|做完|写好|做好|改完|改好|搞定|交付|实现了|提交了|已发|发好|完工|弄好|处理好)|\b(done|finished|completed|implemented|shipped)\b/i;
// Anything a reader could use or check: code, a link, a path or file name, a list.
const CONTENT =
  /```|`[^`\n]+`|https?:\/\/|(?:^|[\s(（])[\w.-]*\/[\w./-]+|\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|py|md|json|go|rs|java|kt|swift|css|html|sql|ya?ml|sh|txt|csv|pdf|png|jpg|docx|xlsx|pptx)\b|\n\s*(?:[-*•]|\d+[.)、])\s/i;
/** Longer than this, a reply is taken to carry its result even without code or links. */
const BARE_MAX_CHARS = 160;

/** Whether a stage's final text claims completion (or says nothing) without any output. */
export function bareCompletionClaim(text: string): boolean {
  const clean = text.trim();
  if (!clean) return true;
  if (clean.length > BARE_MAX_CHARS) return false;
  return DONE.test(clean) && !CONTENT.test(clean);
}

/** The member's prompt when its stage ended with a bare claim. */
export const STAGE_OUTPUT_MISSING_PROMPT = [
  "[system] Your last reply said this stage is done but showed no actual output: no content, code, file, Page or link.",
  "Post the result of your stage here now: the content itself, or the paths or links of what you produced. If it is already in an earlier message, point to that message and repeat its key part.",
  "Do not redo finished work and do not hand the stage off; when you are done, the result goes on as usual.",
].join("\n");
