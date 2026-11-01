import type { MessageBlock } from "@rakazo/contracts";
import { createStreamingRedactor } from "@rakazo/core";

// These are internal routing annotations, including the named-recipient variant.
const ANNOTATION_STARTS = ["（未实际交接", "(未实际交接"];

/** Holds partial annotation prefixes so even a split model echo never reaches progress. */
function annotationFilter() {
  let pending = "";
  let hiding = false;
  return {
    push(chunk: string) {
      let output = "";
      for (const char of chunk) {
        if (hiding) {
          if (char === "）" || char === ")") hiding = false;
          else if (char === "\n") {
            hiding = false;
            output += char;
          }
          continue;
        }
        pending += char;
        while (pending && !ANNOTATION_STARTS.some((prefix) => prefix.startsWith(pending))) {
          output += pending[0];
          pending = pending.slice(1);
        }
        if (ANNOTATION_STARTS.includes(pending)) {
          pending = "";
          hiding = true;
        }
      }
      return output;
    },
    finish() {
      const tail = pending;
      pending = "";
      hiding = false;
      return tail;
    },
    skip() {
      pending = "";
    },
  };
}

export function visibleBotText(text: string): string {
  const filter = annotationFilter();
  const visible = filter.push(text) + filter.finish();
  return visible === text ? text : visible.trimEnd();
}

export function visibleBotBlocks(blocks: MessageBlock[]): MessageBlock[] {
  const text = blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join("");
  if (!ANNOTATION_STARTS.some((prefix) => text.includes(prefix))) return blocks;
  // Join adjacent text blocks first: model/tool output may split the annotation across them.
  const result: MessageBlock[] = [];
  for (const block of blocks) {
    const last = result.at(-1);
    if (block.kind === "text" && last?.kind === "text") last.text += block.text;
    else result.push({ ...block });
  }
  return result.map((block) =>
    block.kind === "text" ? { ...block, text: visibleBotText(block.text) } : block,
  );
}

export function createVisibleBotRedactor(secrets: string[]) {
  const redactor = createStreamingRedactor(secrets);
  const annotations = annotationFilter();
  return {
    push: (chunk: string) => annotations.push(redactor.push(chunk)),
    finish: () => annotations.push(redactor.finish()) + annotations.finish(),
    skip() {
      redactor.skip();
      annotations.skip();
    },
  };
}
