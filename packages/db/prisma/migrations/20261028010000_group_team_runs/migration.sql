-- Additive: the previous release never reads or writes this table. It holds no message
-- content (the goal is the origin message's text, the summary a posted message).
CREATE TABLE "group_team_runs" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "leaderBotId" TEXT NOT NULL,
    "originMessageId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "hops" INTEGER NOT NULL DEFAULT 0,
    "nudges" INTEGER NOT NULL DEFAULT 0,
    "lastLeaderTargetId" TEXT,
    "leaderTargetStreak" INTEGER NOT NULL DEFAULT 0,
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "group_team_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "group_team_runs_originMessageId_key" ON "group_team_runs"("originMessageId");
CREATE INDEX "group_team_runs_threadId_status_idx" ON "group_team_runs"("threadId", "status");
CREATE INDEX "group_team_runs_groupId_idx" ON "group_team_runs"("groupId");

ALTER TABLE "group_team_runs" ADD CONSTRAINT "group_team_runs_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "chat_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same tenant policies as the other space-owned tables.
ALTER TABLE "group_team_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY group_team_runs_tenant ON "group_team_runs"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY group_team_runs_system ON "group_team_runs"
  USING (current_setting('app.rls_bypass', true) = 'on');
