import { z } from "zod";

export const inlineWidgetLanguageSchema = z.enum(["html", "react"]);
export const inlineWidgetCapabilitySchema = z.enum(["display", "request"]);
export const inlineWidgetSourceSchema = z.string().min(1).max(1_048_576);
export const compiledInlineWidgetSchema = z
  .object({
    url: z.url().startsWith("cake-widget://document/"),
    token: z.uuid(),
  })
  .refine((widget) => widget.url === `cake-widget://document/${widget.token}`, {
    message: "Inline widget URL must match its capability token",
    path: ["url"],
  });
export const repairedInlineWidgetSchema = z.object({
  source: inlineWidgetSourceSchema,
  repairSessionId: z.string().min(1).max(256),
});

export type InlineWidgetLanguage = z.infer<typeof inlineWidgetLanguageSchema>;
export type InlineWidgetCapability = z.infer<typeof inlineWidgetCapabilitySchema>;
export type CompiledInlineWidget = z.infer<typeof compiledInlineWidgetSchema>;
export type RepairedInlineWidget = z.infer<typeof repairedInlineWidgetSchema>;
