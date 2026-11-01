-- Additive: older releases never read or write it.
CREATE TABLE "computer_health" (
    "id" TEXT NOT NULL,
    "computerId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3),
    "diskPercent" INTEGER,
    "memoryPercent" INTEGER,
    "alertedResources" TEXT,
    "alertedAt" TIMESTAMP(3),
    "unresponsiveCount" INTEGER NOT NULL DEFAULT 0,
    "restartPromptedAt" TIMESTAMP(3),
    "restartMessageId" TEXT,
    "restartThreadId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "computer_health_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "computer_health_computerId_key" ON "computer_health"("computerId");
ALTER TABLE "computer_health"
ADD CONSTRAINT "computer_health_computerId_fkey"
FOREIGN KEY ("computerId") REFERENCES "computers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
GRANT SELECT, INSERT, UPDATE, DELETE ON "computer_health" TO rakazo_app;
ALTER TABLE "computer_health" ENABLE ROW LEVEL SECURITY;
CREATE POLICY computer_health_system ON "computer_health"
  USING (current_setting('app.rls_bypass', true) = 'on');
CREATE POLICY computer_health_tenant ON "computer_health"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
