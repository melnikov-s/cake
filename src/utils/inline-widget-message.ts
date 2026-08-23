import { z } from "zod";

export const inlineWidgetMessageSchema = z.discriminatedUnion("type", [
  z.object({
    source: z.literal("cake-inline-widget"),
    token: z.string(),
    type: z.literal("height"),
    value: z.number(),
  }),
  z.object({
    source: z.literal("cake-inline-widget"),
    token: z.string(),
    type: z.literal("error"),
    value: z.json(),
  }),
  z.object({
    source: z.literal("cake-inline-widget"),
    token: z.string(),
    type: z.literal("submit"),
    value: z.json(),
  }),
  z.object({
    source: z.literal("cake-inline-widget"),
    token: z.string(),
    type: z.literal("cancel"),
  }),
]);

export function inlineWidgetRepairContext(context: string, instructions: string) {
  return `${context}\n\nUser's requested repair:\n${instructions}`;
}
