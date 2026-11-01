import type { ConnectorTool } from "@rakazo/adapter-kit";
import { BotSecretName } from "@rakazo/contracts";
import { z } from "zod";

export const RevealSecretInput = z
  .object({
    name: BotSecretName,
    field: z.string().trim().min(1).max(200).default("password"),
    origin: z.url(),
  })
  .strict();

export const revealSecretTool: ConnectorTool = {
  name: "reveal_secret",
  description:
    "Only use after browser_act fill_secret failed. Read one saved website login field for manual typing on its saved HTTPS origin. The account owner must enable this. Never echo the value in chat replies, notes, files, or messages; use it only to type into the login form on that site.",
  inputSchema: z.toJSONSchema(RevealSecretInput, { io: "input" }),
};
