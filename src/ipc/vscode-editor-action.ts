import { Schema } from "effect";

const path = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8_192)));

export const vscodeEditorActionSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("layout.set"),
    layout: Schema.Literals(["single", "two-columns", "two-rows", "grid"]),
  }),
  Schema.Struct({
    type: Schema.Literal("diff.open"),
    leftPath: path,
    rightPath: path,
    title: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  }),
  Schema.Struct({ type: Schema.Literal("editor.status") }),
  Schema.Struct({
    type: Schema.Literal("diagnostics.list"),
    path: Schema.optionalKey(path),
  }),
  Schema.Struct({
    type: Schema.Literal("panel.show"),
    panel: Schema.Literals([
      "explorer",
      "search",
      "source-control",
      "problems",
      "output",
      "terminal",
      "debug-console",
    ]),
  }),
]);

export type VscodeEditorAction = Schema.Schema.Type<typeof vscodeEditorActionSchema>;
