import { getSavedPasswordSettings, updateSavedPasswordSettings } from "@rakazo/db";
import type { RouterContext } from "./context.js";

/** Account consent always belongs to the authenticated person, never a selected bot or Space. */
export function savedPasswordSettingsRoutes({ deps, authed }: RouterContext) {
  return {
    savedPasswordSettings: {
      get: authed.savedPasswordSettings.get.handler(({ context }) =>
        getSavedPasswordSettings(deps.prisma, context.actor.userId),
      ),
      update: authed.savedPasswordSettings.update.handler(({ context, input }) =>
        updateSavedPasswordSettings(deps.prisma, context.actor.userId, input),
      ),
    },
  };
}
