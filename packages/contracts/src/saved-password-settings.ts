import { oc } from "@orpc/contract";
import { z } from "zod";

export const SavedPasswordSettings = z.object({ allowBotPasswordReveal: z.boolean() }).strict();

export const savedPasswordSettingsContract = {
  get: oc.output(SavedPasswordSettings),
  update: oc.input(SavedPasswordSettings).output(SavedPasswordSettings),
};
