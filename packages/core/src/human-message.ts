/** Stored message authorship. `runId` is not an author: human steering has one too. */
export type MessageAuthorship = {
  role: string;
  botId?: string | null;
  blocks: unknown;
};

/**
 * Peer deliveries use the user's model role, but their structured receipt identifies the bot
 * author even when botId is null. The message schema has no explicit sender-user field.
 */
export function isHumanAuthoredMessage(message: MessageAuthorship | null | undefined): boolean {
  return Boolean(
    message &&
      message.role === "user" &&
      !message.botId &&
      !(
        Array.isArray(message.blocks) &&
        message.blocks.some(
          (block: unknown) =>
            block !== null &&
            typeof block === "object" &&
            "kind" in block &&
            (block.kind === "bot_message_received" ||
              block.kind === "bot_message_sent" ||
              block.kind === "handoff"),
        )
      ),
  );
}
