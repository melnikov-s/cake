import { Schema } from "effect";
import { jsonSchemaSchema } from "./artifact-contract";
import { inlineWidgetLanguageSchema, inlineWidgetSourceSchema } from "./inline-widget-contract";

const REQUEST_PROTOCOL = "cake.request/v1" as const;
const requestIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const formFieldSchema = Schema.Struct({
  id: requestIdSchema,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  type: Schema.Literals(["text", "textarea", "number", "checkbox", "select"]),
  placeholder: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  options: Schema.optional(
    Schema.Array(
      Schema.Struct({
        value: Schema.String.check(Schema.isMaxLength(256)),
        label: Schema.String.check(Schema.isMaxLength(512)),
      }),
    ).check(Schema.isMaxLength(200)),
  ),
});
const requestViewSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("form"),
    fields: Schema.Array(formFieldSchema).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
  Schema.Struct({
    type: Schema.Literal("widget"),
    language: inlineWidgetLanguageSchema,
    source: inlineWidgetSourceSchema,
  }),
]);
export const cakeRequestV1Schema = Schema.Struct({
  protocol: Schema.Literal(REQUEST_PROTOCOL),
  id: requestIdSchema,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  responseSchema: jsonSchemaSchema,
  view: requestViewSchema,
  fallback: Schema.Struct({
    markdown: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_048_576)),
  }),
}).check(
  Schema.makeFilter((request) =>
    request.view.type === "form" &&
    request.responseSchema.type === "object" &&
    request.responseSchema.required?.length
      ? "Form fields are optional and cannot be required by the response schema"
      : undefined,
  ),
);

export type CakeRequestV1 = typeof cakeRequestV1Schema.Type;
export type CakeRequestView = typeof requestViewSchema.Type;

export function parseRequestInput(input: unknown): CakeRequestV1 {
  const bytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
  if (bytes > 1_048_576) throw new Error("Request input exceeds the 1 MB limit");
  return Schema.decodeUnknownSync(cakeRequestV1Schema)(input);
}
