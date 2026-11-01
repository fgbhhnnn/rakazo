-- Background tasks become durable task records: a stable ref is the handle the dispatcher uses,
-- a claim lease makes a crash between claiming and starting recoverable, and the worker run the
-- task is bound to attributes its result. Additive only.
ALTER TABLE "background_task_queue"
  ADD COLUMN "ref" TEXT,
  ADD COLUMN "taskHash" TEXT,
  ADD COLUMN "workerRunId" TEXT,
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "error" TEXT,
  ADD COLUMN "finishedAt" TIMESTAMP(3);

-- Rows started by the earlier implementation were never finalized; their workers are tracked by
-- their runs, so close them out instead of letting them hold a slot under the new rules.
UPDATE "background_task_queue"
SET "status" = 'completed', "finishedAt" = COALESCE("startedAt", "createdAt")
WHERE "status" = 'started';

CREATE INDEX "background_task_queue_botId_ref_idx" ON "background_task_queue"("botId", "ref");
CREATE INDEX "background_task_queue_workerRunId_idx" ON "background_task_queue"("workerRunId");
CREATE INDEX "background_task_queue_workerBotId_status_idx" ON "background_task_queue"("workerBotId", "status");
