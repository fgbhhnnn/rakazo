import { BOT_MESSAGE_MAX_LENGTH } from "@rakazo/core";
import { clampUserProgressMessage } from "./user-progress.js";

/**
 * Cap on the model's own reply text that the system posts while the turn goes on (mid-turn
 * narration promoted before a handoff, a takeover, or a dispatcher question). That text is what
 * the model wrote for the user, often a code block or a draft, so it gets the full bot message
 * size, not the short message_user cap: at 500 characters code was cut off mid-line.
 */
export const MID_TURN_NARRATION_MAX_LENGTH = BOT_MESSAGE_MAX_LENGTH;

export function clampMidTurnNarration(text: string): string {
  return clampUserProgressMessage(text, MID_TURN_NARRATION_MAX_LENGTH);
}
