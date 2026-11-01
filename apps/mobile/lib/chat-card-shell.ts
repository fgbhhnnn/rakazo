import type { useMobileTokens } from "./native";

type Tokens = Pick<ReturnType<typeof useMobileTokens>, "card">;

/** Corner radius of a card in the thread, matching ChoiceCard, ComputerCard and approvals. */
export const CHAT_CARD_RADIUS = 18;

/**
 * The borderless shell every chat card shares (web: BuiCard): the card fill and the
 * thread card radius, with no outline. Pass a fill to show press feedback.
 */
export function chatCardShell(tokens: Tokens, fill: string = tokens.card) {
  return { borderRadius: CHAT_CARD_RADIUS, backgroundColor: fill } as const;
}
