import type { ThreadMessage } from "@rakazo/contracts";

type AskBlock = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;

/** Names the background task whose approval this main-chat card answers. */
export function WorkerApprovalLabel({ block }: { block: AskBlock }) {
  if (!block.workerApproval) return null;
  return (
    <div
      data-testid="worker-approval-label"
      className="mb-1.5 text-[13px] leading-[1.4] text-muted-foreground"
    >
      {block.workerApproval.label}
    </div>
  );
}
