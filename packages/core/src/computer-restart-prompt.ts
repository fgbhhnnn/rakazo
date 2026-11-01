/*
 * When a computer stops answering several checks in a row, the owner's main chat gets a card
 * asking whether to restart it from its last checkpoint. The card has no run: an answer carries
 * the computer id where other cards carry a run id, and the server restarts the computer only
 * on an explicit "restart" answer from its owner. It always asks; no approval setting skips it.
 */

export const COMPUTER_RESTART_ACTION = "restart";
export const COMPUTER_KEEP_ACTION = "keep";

type RestartPromptLike = {
  kind: string;
  status?: string;
  computerRestart?: { computerId: string; closed?: string };
};

/** The block is a restart card the owner can still answer. */
export function isOpenComputerRestartPrompt(block: RestartPromptLike): boolean {
  return (
    block.kind === "ask" &&
    Boolean(block.computerRestart) &&
    block.status !== "answered" &&
    !block.computerRestart?.closed
  );
}
