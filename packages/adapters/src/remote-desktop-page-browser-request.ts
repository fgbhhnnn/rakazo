import { z } from "zod";

// Keep the supervisor browser route constraints in sync (checked by the colocated test).
export const remotePageBrowserRequest = z.discriminatedUnion("command", [
  z.object({
    command: z.literal("navigate"),
    url: z
      .string()
      .url()
      .max(8192)
      .refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return /^https?:$/.test(url.protocol) && !url.username && !url.password;
      }),
  }),
  z.object({ command: z.literal("snapshot") }),
  z.object({
    command: z.literal("act"),
    actions: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("click"), ref: z.string().min(1).max(200) }),
          z.object({
            kind: z.literal("upload"),
            ref: z.string().min(1).max(200),
            paths: z.array(z.string().min(1).max(1024)).min(1).max(10),
            roots: z.array(z.string().min(1).max(1024)).max(2).optional(),
          }),
          z.object({
            kind: z.literal("pay_token"),
            text: z.string().min(1).max(4096),
            origin: z.string().url().max(2048),
            merchantAccountId: z.string().min(1).max(128),
          }),
          z
            .object({
              kind: z.enum(["fill", "type"]),
              ref: z.string().min(1).max(200).optional(),
              text: z.string().max(32_000),
              origin: z.string().url().max(2048).optional(),
              field: z.enum(["username", "password", "card"]).optional(),
              cardField: z.enum(["number", "expiry", "cvc", "postal_code"]).optional(),
            })
            // The field decides which input types the helper accepts for a saved login or card.
            .refine((step) => !step.origin || step.field, "A saved login fill needs its field")
            // A card detail is hidden and checked only when bound to the merchant's origin.
            .refine((step) => step.field !== "card" || step.origin, "A card fill needs its origin")
            .refine(
              (step) =>
                step.cardField
                  ? step.kind === "fill" && step.field === "card" && !step.ref
                  : Boolean(step.ref),
              "A fill needs either its ref or, for a card, its card field",
            ),
        ]),
      )
      .min(1)
      .max(24),
  }),
]);
