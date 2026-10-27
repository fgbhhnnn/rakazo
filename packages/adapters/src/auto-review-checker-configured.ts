import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { AutoReviewChecker } from "./auto-review.js";
import { isAutoReviewCheckerConfigured } from "./auto-review.js";
import { findConnectedModelCredential } from "./model-selection.js";

/**
 * Whether Auto can hand an action to an approval model, or must fall back to asking.
 * The checker's connection is looked up in the run's model scope: the owner's for a member on
 * the owner's shared models (see sharedModelScope), which is also where the review then reads
 * its key (see autoReviewCheckerProvider). Without a checker anywhere this stays false.
 */
export async function runAutoReviewCheckerConfigured(
  deps: { prisma: PrismaClient; secretStore: Pick<SecretStore, "load"> },
  input: {
    reviewable: boolean;
    injectedReview: boolean;
    memberChecker: boolean;
    backups: number;
    checker: AutoReviewChecker | null | undefined;
    modelScope: { userId: string; spaceId: string };
  },
): Promise<boolean> {
  const { reviewable, injectedReview, memberChecker, backups, checker, modelScope } = input;
  return (
    reviewable &&
    (injectedReview ||
      memberChecker ||
      backups > 0 ||
      (checker
        ? isAutoReviewCheckerConfigured({}) ||
          Boolean(
            await findConnectedModelCredential(
              deps.prisma,
              deps.secretStore,
              modelScope,
              checker.provider,
            ),
          )
        : false))
  );
}
