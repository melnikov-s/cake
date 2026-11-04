import { Schema } from "effect";
import {
  editorLocationFromPath,
  editorPresentationFields,
  type EditorLocation,
} from "./editor-location";
import { gitRevisionSchema } from "./source-location";

const coordinate = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000_001 }));
const path = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(8_192));

/** Public navigation has no selection or diff data. Coordinates are one-based. */
export const VscodeOpenInput = Schema.Struct({ path, line: Schema.optionalKey(coordinate) });
export interface VscodeOpenInput extends Schema.Schema.Type<typeof VscodeOpenInput> {}

/** A source range; omitted end coordinates select through the end of the final line. */
export const VscodeSelectionInput = Schema.Struct({
  path,
  group: editorPresentationFields.group,
  preview: editorPresentationFields.preview,
  preserveFocus: editorPresentationFields.preserveFocus,
  line: coordinate,
  column: Schema.optionalKey(coordinate),
  endLine: Schema.optionalKey(coordinate),
  endColumn: Schema.optionalKey(coordinate),
  view: Schema.optionalKey(Schema.Literal("changes")),
  side: Schema.optionalKey(Schema.Literals(["before", "after"])),
  base: Schema.optionalKey(gitRevisionSchema),
}).check(
  Schema.makeFilter((input) => {
    if ((input.endLine ?? input.line) < input.line) return "endLine cannot precede line";
    if (
      (input.endLine ?? input.line) === input.line &&
      input.endColumn !== undefined &&
      input.endColumn < (input.column ?? 1)
    )
      return "endColumn cannot precede column";
    if (input.side !== undefined && input.view !== "changes") return "side requires changes view";
    if (input.base !== undefined && input.view !== "changes") return "base requires changes view";
    return undefined;
  }),
);
export interface VscodeSelectionInput extends Schema.Schema.Type<typeof VscodeSelectionInput> {}
export const VscodeSelectionsInput = Schema.Struct({
  selections: Schema.Array(VscodeSelectionInput).check(Schema.isMaxLength(50)),
});
export interface VscodeSelectionsInput extends Schema.Schema.Type<typeof VscodeSelectionsInput> {}

export function selectionEditorLocation(input: VscodeSelectionInput): EditorLocation {
  return {
    ...editorLocationFromPath({
      path: input.path,
      ...(input.view ? { view: input.view } : null),
      ...(input.side ? { side: input.side } : null),
      ...(input.base ? { base: input.base } : null),
      range: {
        start: {
          line: input.line - 1,
          ...(input.column !== undefined ? { column: input.column - 1 } : null),
        },
        end: {
          line: (input.endLine ?? input.line) - 1,
          ...(input.endColumn !== undefined ? { column: input.endColumn - 1 } : null),
        },
      },
    }),
    ...(input.group ? { group: input.group } : null),
    ...(input.preview !== undefined ? { preview: input.preview } : null),
    ...(input.preserveFocus !== undefined ? { preserveFocus: input.preserveFocus } : null),
  };
}

export function navigationEditorLocation(input: VscodeOpenInput): EditorLocation {
  return {
    ...editorLocationFromPath({ path: input.path }),
    ...(input.line !== undefined ? { line: input.line - 1 } : null),
  };
}
