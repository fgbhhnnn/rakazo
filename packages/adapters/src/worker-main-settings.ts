import type { PrismaClient } from "@rakazo/db";

/*
 * A hidden worker acts for its main bot, so it carries the main bot's own instructions below
 * the worker rules (the rules win where they conflict), and every tool the owner turned off
 * for the main bot stays off for its workers too.
 */

export const MAIN_BOT_INSTRUCTIONS_HEADER =
  "以下是主 bot 的设定（用户给主 bot 写的指令）。按它的要求做事和产出；和上面的后台工作者规则冲突时，以上面的规则为准。";

export function workerInstructions(
  base: string,
  mainInstructions: string | null | undefined,
): string {
  const main = mainInstructions?.trim();
  return main ? `${base}\n\n${MAIN_BOT_INSTRUCTIONS_HEADER}\n\n${main}` : base;
}

export function workerDisabledWithMain(
  taskDisabled: readonly string[],
  mainDisabled: readonly string[] | null | undefined,
): string[] {
  return [...new Set([...taskDisabled, ...(mainDisabled ?? [])])];
}

/** The per-task instructions and disabled tools of a worker of mainBotId, read from the main bot now. */
export async function workerSettingsFromMain(
  prisma: Pick<PrismaClient, "bot">,
  mainBotId: string,
  base: string,
  taskDisabled: readonly string[],
): Promise<{ instructions: string; disabledBuiltinTools: string[] }> {
  const main = await prisma.bot.findUnique({
    where: { id: mainBotId },
    select: { instructions: true, disabledBuiltinTools: true },
  });
  return {
    instructions: workerInstructions(base, main?.instructions),
    disabledBuiltinTools: workerDisabledWithMain(taskDisabled, main?.disabledBuiltinTools),
  };
}
