import { z } from "zod";
import { jsonSchemaSchema } from "./artifact-contract";
import { inlineWidgetLanguageSchema, inlineWidgetSourceSchema } from "./inline-widget-contract";

export const REQUEST_PROTOCOL = "cake.request/v1" as const;
const requestIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const formFieldSchema = z.object({
  id: requestIdSchema,
  label: z.string().min(1).max(512),
  type: z.enum(["text", "textarea", "number", "checkbox", "select"]),
  required: z.boolean().default(false),
  placeholder: z.string().max(512).optional(),
  options: z.array(z.object({ value: z.string().max(256), label: z.string().max(512) })).max(200).optional()
});

export const requestViewSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("form"), fields: z.array(formFieldSchema).min(1).max(200), submitLabel: z.string().max(128).default("Submit") }),
  z.object({ type: z.literal("widget"), language: inlineWidgetLanguageSchema, source: inlineWidgetSourceSchema })
]);

export const cakeRequestV1Schema = z.object({
  protocol: z.literal(REQUEST_PROTOCOL),
  id: requestIdSchema,
  title: z.string().min(1).max(512),
  responseSchema: jsonSchemaSchema,
  view: requestViewSchema,
  fallback: z.object({ markdown: z.string().min(1).max(1_048_576) })
}).strict();

export type CakeRequestV1 = z.infer<typeof cakeRequestV1Schema>;
export type CakeRequestView = z.infer<typeof requestViewSchema>;

export function parseRequestInput(input: unknown): CakeRequestV1 {
  const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  if (bytes > 1_048_576) throw new Error("Request input exceeds the 1 MB limit");
  return cakeRequestV1Schema.parse(input);
}
