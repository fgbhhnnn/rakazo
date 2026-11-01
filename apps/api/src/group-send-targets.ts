import { deferredHandoffTargetId, resolveGroupTargetBotIds } from "@rakazo/core";

/** Model admission and run creation must agree on who starts before a requested handoff. */
export function groupSendTargetBotIds(input: {
  text: string;
  members: Array<{ id: string; name: string }>;
  explicitMentions: string[];
}): string[] {
  const mentioned = resolveGroupTargetBotIds(input);
  const deferred = deferredHandoffTargetId(input.text, input.members, mentioned);
  return mentioned.filter((id) => id !== deferred);
}
