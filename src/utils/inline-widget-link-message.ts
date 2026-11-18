import { Schema } from "effect";

/** Direction zero is pointer interaction; signed directions are escaping scroll gestures. */
export const inlineWidgetScrollInputMessage = Schema.Struct({
  source: Schema.Literal("cake-inline-widget"),
  token: Schema.String,
  type: Schema.Literal("scroll-input"),
  value: Schema.Literals([-1, 0, 1]),
});

export const inlineWidgetEscapeMessage = Schema.Struct({
  source: Schema.Literal("cake-inline-widget"),
  token: Schema.String,
  type: Schema.Literal("escape"),
});

/** URL syntax is checked here; the existing host opener owns allowed schemes. */
export const inlineWidgetLinkMessage = Schema.Struct({
  source: Schema.Literal("cake-inline-widget"),
  token: Schema.String,
  type: Schema.Literal("open-link"),
  value: Schema.Struct({
    url: Schema.String.check(Schema.makeFilter((value) => URL.canParse(value))),
  }),
});
