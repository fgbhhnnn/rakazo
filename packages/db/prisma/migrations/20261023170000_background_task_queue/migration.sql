-- background_task requests waiting for a free worker slot (FIFO per dispatcher bot).
CREATE TABLE "background_task_queue" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "workerBotId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    CONSTRAINT "background_task_queue_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "background_task_queue_botId_status_createdAt_idx"
ON "background_task_queue"("botId", "status", "createdAt");
ALTER TABLE "background_task_queue"
ADD CONSTRAINT "background_task_queue_botId_fkey"
FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
GRANT SELECT, INSERT, UPDATE, DELETE ON "background_task_queue" TO rakazo_app;
ALTER TABLE "background_task_queue" ENABLE ROW LEVEL SECURITY;
CREATE POLICY background_task_queue_system ON "background_task_queue"
  USING (current_setting('app.rls_bypass', true) = 'on');
CREATE POLICY background_task_queue_tenant ON "background_task_queue"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
