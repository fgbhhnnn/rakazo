import { z } from "zod";

// Keep the supervisor browser route constraints in sync (checked by the colocated test).
const downloadFolder = z.string().min(1).max(1024).optional();

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
    downloads: downloadFolder,
  }),
  z.object({
    command: z.literal("snapshot"),
    query: z.string().max(200).optional(),
    downloads: downloadFolder,
  }),
  z.object({ command: z.literal("restart") }),
  z.object({
    command: z.literal("purchase_check"),
    // Only clicks are looked at; `desktop` asks about a click or key on the screen instead.
    actions: z
      .array(z.object({ kind: z.string().max(40), ref: z.string().max(200).optional() }))
      .max(24)
      .optional(),
    desktop: z.boolean().optional(),
    enter: z.boolean().optional(),
    unplaced: z.boolean().optional(),
    points: z
      .array(z.object({ x: z.number().finite(), y: z.number().finite() }))
      .max(24)
      .optional(),
  }),
  z.object({
    command: z.literal("act"),
    downloads: downloadFolder,
    actions: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("click"),
            ref: z.string().min(1).max(200),
            // The user approved a purchase click on this site (see rakazo-page-browser).
            approved: z.boolean().optional(),
            // Empty for a page without a host (about:blank, data:, file:).
            site: z.string().max(253).optional(),
            label: z.string().max(200).optional(),
            amount: z.string().max(100).optional(),
          }),
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
              field: z.enum(["username", "password", "card", "code"]).optional(),
              cardField: z.enum(["number", "expiry", "cvc", "postal_code"]).optional(),
            })
            // The field decides which input types the helper accepts for a saved login or card.
            .refine((step) => !step.origin || step.field, "A saved login fill needs its field")
            // A card detail is hidden and checked only when bound to the merchant's origin.
            .refine((step) => step.field !== "card" || step.origin, "A card fill needs its origin")
            // A one-time code goes into one field of the site that asked for it.
            .refine(
              (step) => step.field !== "code" || (step.kind === "fill" && step.ref && step.origin),
              "A code fill needs its ref and origin",
            )
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
