import { Schema } from "effect";

export const inlineWidgetLanguageSchema = Schema.Literals(["html", "react"]);
export const inlineWidgetCapabilitySchema = Schema.Literals([
  "display",
  "request",
  "session-plugin",
]);
export const inlineWidgetSourceSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1_048_576),
);
export const compiledInlineWidgetSchema = Schema.Struct({
  url: Schema.String.check(
    Schema.makeFilter((url) => {
      try {
        return new URL(url).protocol === "cake-widget:"
          ? undefined
          : "must use the Cake widget protocol";
      } catch {
        return "must be a valid URL";
      }
    }),
  ),
  token: Schema.String.check(Schema.isUUID()),
}).check(
  Schema.makeFilter((widget) =>
    widget.url === `cake-widget://document/${widget.token}`
      ? undefined
      : "Inline widget URL must match its capability token",
  ),
);
export type InlineWidgetLanguage = typeof inlineWidgetLanguageSchema.Type;
export type InlineWidgetCapability = typeof inlineWidgetCapabilitySchema.Type;
export type CompiledInlineWidget = typeof compiledInlineWidgetSchema.Type;
