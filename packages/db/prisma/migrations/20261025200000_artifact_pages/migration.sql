-- Additive: older releases never read or write it; their artifacts stay plain files (NULL).
ALTER TABLE "artifacts" ADD COLUMN "kind" TEXT;
CREATE INDEX "artifacts_spaceId_kind_idx" ON "artifacts"("spaceId", "kind");
