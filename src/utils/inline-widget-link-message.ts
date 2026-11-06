import { Schema } from "effect";

/** URL syntax is checked here; the existing host opener owns allowed schemes. */
export const inlineWidgetLinkMessage = Schema.Struct({
  source: Schema.Literal("cake-inline-widget"),
  token: Schema.String,
  type: Schema.Literal("open-link"),
  value: Schema.Struct({
    url: Schema.String.check(Schema.makeFilter((value) => URL.canParse(value))),
  }),
});
