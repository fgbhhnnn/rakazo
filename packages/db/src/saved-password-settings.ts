import type { PrismaClient } from "./client.js";

export async function getSavedPasswordSettings(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { allowBotPasswordReveal: true },
  });
  return { allowBotPasswordReveal: user?.allowBotPasswordReveal === true };
}

export async function updateSavedPasswordSettings(
  prisma: PrismaClient,
  userId: string,
  input: { allowBotPasswordReveal: boolean },
) {
  return prisma.user.update({
    where: { id: userId },
    data: { allowBotPasswordReveal: input.allowBotPasswordReveal },
    select: { allowBotPasswordReveal: true },
  });
}
