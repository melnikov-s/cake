import { Schema } from "effect";

/** An immutable browser build; the potentially large bundle/resources remain backend files. */
export const WidgetBrowserOutput = Schema.Struct({
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export interface WidgetBrowserOutput extends Schema.Schema.Type<typeof WidgetBrowserOutput> {}
