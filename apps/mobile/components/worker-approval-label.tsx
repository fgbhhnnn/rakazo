import type { MessageBlock } from "@rakazo/contracts";
import { workerApprovalClosedState } from "@rakazo/core";
import { typeScale } from "@rakazo/ui-tokens";
import { Text } from "react-native";
import { useMobileTokens } from "../lib/native";

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

/** Names the background task whose approval this main-chat card answers. */
export function WorkerApprovalLabel({ block }: { block: AskBlock }) {
  const tokens = useMobileTokens();
  if (!block.workerApproval) return null;
  return (
    <Text
      testID="worker-approval-label"
      style={{ color: tokens.mutedForeground, marginBottom: 6, ...typeScale.caption }}
    >
      {block.workerApproval.label}
    </Text>
  );
}

/** What a card that can no longer be answered says: a cancelled worker's copy says so. */
export function inactiveAskText(block: AskBlock): "Cancelled" | "No longer active" {
  return workerApprovalClosedState(block) === "cancelled" ? "Cancelled" : "No longer active";
}
