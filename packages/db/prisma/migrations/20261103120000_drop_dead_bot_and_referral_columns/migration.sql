-- The previous release no longer reads these.
-- The fork keeps bots.title for hidden worker titles and idempotent child spawn replay.
ALTER TABLE "bots" DROP COLUMN "selfUpdateInstructions";

ALTER TABLE "referrals" DROP COLUMN "rewardKind";
ALTER TABLE "referrals" DROP COLUMN "declinedAt";
