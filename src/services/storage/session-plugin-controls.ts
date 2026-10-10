import { Schema } from "effect";

const text = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

/** One preset covers action bars, guided steps, and small message-based choices. */
export const SessionPluginControls = Schema.Struct({
  label: text(512),
  progress: Schema.optionalKey(
    Schema.Struct({
      current: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    }).check(Schema.makeFilter((progress) => progress.current <= progress.total)),
  ),
  actions: Schema.Array(
    Schema.Struct({
      id: text(128),
      label: text(128),
      message: text(65_536),
      primary: Schema.optionalKey(Schema.Boolean),
      disabled: Schema.optionalKey(Schema.Boolean),
    }),
  ).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
    Schema.makeFilter(
      (actions) => new Set(actions.map((action) => action.id)).size === actions.length,
    ),
  ),
});
export interface SessionPluginControls extends Schema.Schema.Type<typeof SessionPluginControls> {}
