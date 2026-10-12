import { Schema } from "effect";
import {
  editorLocationFromPath,
  type EditorLocation,
} from "../../contracts/editor/editor-location";
import type { VscodeEditorAction } from "../../contracts/vscode/vscode-editor-action";
import { EditorSelectionId } from "../../contracts/editor/editor-selection";
import {
  gitRevisionSchema,
  type SourceLocation,
  type SourcePosition,
} from "../../contracts/editor/source-location";
import type { AppControlResult } from "./app-control-data";
import { trimmed, emptyArgumentsSchema } from "./control-arguments";
import { defineControl } from "./control-definition";
const vscodeOpenArgs = Schema.Struct({
  path: trimmed(1, 8192),
  view: Schema.optionalKey(Schema.Literal("changes")),
  side: Schema.optionalKey(Schema.Literals(["before", "after"])),
  base: Schema.optionalKey(gitRevisionSchema),
  group: Schema.optionalKey(
    Schema.Literals([
      "active",
      "beside",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
    ]),
  ),
  preview: Schema.optionalKey(Schema.Boolean),
  preserveFocus: Schema.optionalKey(Schema.Boolean),
  line: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000001 }))),
  column: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000001 }))),
  endLine: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000001 })),
  ),
  endColumn: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000001 })),
  ),
}).check(
  Schema.makeFilter((input) => {
    if (input.line === undefined && input.column !== undefined) return "column requires line";
    if (input.line === undefined && input.endLine !== undefined) return "endLine requires line";
    if (input.line === undefined && input.endColumn !== undefined) return "endColumn requires line";
    if (input.endLine !== undefined && input.line !== undefined && input.endLine < input.line)
      return "endLine cannot precede line";
    return undefined;
  }),
);
type VscodeOpenInput = typeof vscodeOpenArgs.Type;
function sourceLocation(input: VscodeOpenInput): SourceLocation {
  const presentation = {
    ...(input.view ? { view: input.view } : null),
    ...(input.side ? { side: input.side } : null),
    ...(input.base ? { base: input.base } : null),
  };
  if (input.line === undefined) return { path: input.path, ...presentation };
  const start: SourcePosition =
    input.column === undefined
      ? { line: input.line - 1 }
      : { line: input.line - 1, column: input.column - 1 };
  const end: SourcePosition =
    input.endColumn === undefined
      ? { line: (input.endLine ?? input.line) - 1 }
      : { line: (input.endLine ?? input.line) - 1, column: input.endColumn - 1 };
  return { path: input.path, ...presentation, range: { start, end } };
}
export const vscodeControls = [
  defineControl({
    command: "vscode.selections.list",
    args: Schema.Struct({}),
    scope: "session-assistant",
    discovery: {
      topic: "vscode",
      summary: "List the parent session's code-tour selections.",
      guidance: [
        "Ranged opens accumulate session-local selections until explicitly removed or cleared. Clear the previous tour step before presenting another.",
        "Selection state is ephemeral and not persisted across Cake restarts. List/remove/clear work while VS Code is hidden.",
      ],
    },
    run: async (_input, { host, source }, command): Promise<AppControlResult> => {
      if (source?.kind !== "project-session" || !source.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a parent Project Session Working Directory.",
        };
      return {
        ok: true,
        command,
        state: host.vscode.listSelections(source),
      };
    },
  }),
  defineControl({
    command: "vscode.selections.remove",
    args: Schema.Struct({ id: EditorSelectionId }),
    scope: "session-assistant",
    discovery: {
      topic: "vscode",
      summary: "Remove one parent-session selection by ID.",
      guidance: [
        "Ranged opens accumulate session-local selections until explicitly removed or cleared. Clear the previous tour step before presenting another.",
        "Selection state is ephemeral and not persisted across Cake restarts. List/remove/clear work while VS Code is hidden.",
      ],
    },
    run: async (input, { host, source }, command): Promise<AppControlResult> => {
      if (source?.kind !== "project-session" || !source.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a parent Project Session Working Directory.",
        };
      return {
        ok: true,
        command,
        update: await host.vscode.removeSelection(source, input.id),
      };
    },
  }),
  defineControl({
    command: "vscode.selections.clear",
    args: Schema.Struct({}),
    scope: "session-assistant",
    discovery: {
      topic: "vscode",
      summary: "Clear the parent session's code-tour selections.",
      guidance: [
        "Ranged opens accumulate session-local selections until explicitly removed or cleared. Clear the previous tour step before presenting another.",
        "Selection state is ephemeral and not persisted across Cake restarts. List/remove/clear work while VS Code is hidden.",
      ],
    },
    run: async (_input, { host, source }, command): Promise<AppControlResult> => {
      if (source?.kind !== "project-session" || !source.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a parent Project Session Working Directory.",
        };
      return {
        ok: true,
        command,
        update: await host.vscode.clearSelections(source),
      };
    },
  }),
  defineControl({
    command: "vscode.enter",
    args: Schema.Struct({}),
    scope: "session-assistant",
    discovery: {
      topic: "vscode",
      summary: "Enter embedded VS Code mode for the parent Project Session.",
      guidance: [
        "These operations target the parent Project Session and its Working Directory.",
        "Call vscode.enter before vscode.open when the user asks to open a file in embedded VS Code.",
      ],
      result:
        "Confirmation that Cake entered embedded VS Code mode for the parent Project Session.",
    },
    run: async (_input, { host, source }, command): Promise<AppControlResult> => {
      if (source?.kind !== "project-session" || !source.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a parent Project Session Working Directory.",
        };
      await host.vscode.enter(source);
      return { ok: true, command, entered: true };
    },
  }),
  defineControl({
    command: "vscode.open",
    args: vscodeOpenArgs,
    scope: "session-assistant",
    discovery: {
      topic: "vscode",
      summary:
        "Open a Working Directory or absolute local file in embedded VS Code and highlight an optional source range.",
      guidance: [
        "These operations target the parent Project Session and its Working Directory.",
        "Paths may be relative to the parent Project Session's Working Directory or absolute local file paths.",
        "Opening an absolute path does not add it to the project or change the Working Directory. Lines and columns are one-based.",
        "Call vscode.enter before vscode.open when the user asks to open a file in embedded VS Code.",
      ],
      examples: [
        {
          input: {
            path: "src/main.ts",
            line: 1,
          },
        },
        {
          input: {
            path: "tests/main.test.ts",
            group: "beside",
            preview: false,
          },
          description: "Open a test beside the current editor.",
        },
      ],
      result:
        "The opened location, resolved ranges and selection IDs. Selections accumulate until removed or cleared.",
    },
    run: async (input, { host, source }, command): Promise<AppControlResult> => {
      if (source?.kind !== "project-session" || !source.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a parent Project Session Working Directory.",
        };
      const location = {
        ...editorLocationFromPath(sourceLocation(input)),
        ...(input.group ? { group: input.group } : null),
        ...(input.preview !== undefined ? { preview: input.preview } : null),
        ...(input.preserveFocus !== undefined ? { preserveFocus: input.preserveFocus } : null),
      } satisfies EditorLocation;
      const selection = await host.vscode.open(source, location);
      return { ok: true, command, opened: location, selection };
    },
  }),
  defineControl({
    command: "vscode.layout.set",
    args: Schema.Struct({
      layout: Schema.Literals(["single", "two-columns", "two-rows", "grid"]),
    }),
    scope: "session-assistant",
    discovery: {
      topic: "vscode",
      summary: "Arrange embedded VS Code editor groups using a safe layout preset.",
      examples: [
        {
          input: {
            layout: "two-columns",
          },
        },
      ],
      result: "The applied editor layout.",
    },
    run: async (input, { host, source }, command): Promise<AppControlResult> => {
      if (source?.kind !== "project-session" || !source.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a parent Project Session Working Directory.",
        };
      const action: VscodeEditorAction = { type: "layout.set", ...input };
      const result = await host.vscode.performEditorAction(source, action);
      return { ok: true, command, result };
    },
  }),
  defineControl({
    command: "vscode.diff.open",
    args: Schema.Struct({
      leftPath: trimmed(1, 8192),
      rightPath: trimmed(1, 8192),
      title: Schema.optionalKey(trimmed(1, 256)),
    }),
    scope: "session-assistant",
    discovery: {
      topic: "vscode",
      summary: "Open a native diff between two Working Directory-relative files.",
      examples: [
        {
          input: {
            leftPath: "src/main.ts",
            rightPath: "tests/main.test.ts",
            title: "Implementation ↔ test",
          },
        },
      ],
      result: "The paths opened in the native diff editor.",
      limitations: [
        "Both paths must remain inside the parent Project Session's Working Directory.",
      ],
    },
    run: async (input, { host, source }, command): Promise<AppControlResult> => {
      if (source?.kind !== "project-session" || !source.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a parent Project Session Working Directory.",
        };
      const action: VscodeEditorAction = { type: "diff.open", ...input };
      const result = await host.vscode.performEditorAction(source, action);
      return { ok: true, command, result };
    },
  }),
  defineControl({
    command: "vscode.editor.status",
    args: emptyArgumentsSchema,
    scope: "session-assistant",
    discovery: {
      topic: "vscode",
      summary: "Inspect the active and visible embedded VS Code editors and groups.",
      result: "The active editor position and up to 32 visible editors.",
    },
    run: async (_input, { host, source }, command): Promise<AppControlResult> => {
      if (source?.kind !== "project-session" || !source.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a parent Project Session Working Directory.",
        };
      const action: VscodeEditorAction = { type: "editor.status" };
      const result = await host.vscode.performEditorAction(source, action);
      return { ok: true, command, result };
    },
  }),
  defineControl({
    command: "vscode.diagnostics.list",
    args: Schema.Struct({ path: Schema.optionalKey(trimmed(1, 8192)) }),
    scope: "session-assistant",
    discovery: {
      topic: "vscode",
      summary:
        "List embedded VS Code diagnostics for one Working Directory-relative file or the workspace.",
      examples: [
        {
          input: {
            path: "src/main.ts",
          },
        },
      ],
      result: "Up to 500 diagnostics with source ranges and a truncation flag.",
    },
    run: async (input, { host, source }, command): Promise<AppControlResult> => {
      if (source?.kind !== "project-session" || !source.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a parent Project Session Working Directory.",
        };
      const action: VscodeEditorAction = { type: "diagnostics.list", ...input };
      const result = await host.vscode.performEditorAction(source, action);
      return { ok: true, command, result };
    },
  }),
  defineControl({
    command: "vscode.panel.show",
    args: Schema.Struct({
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
    scope: "session-assistant",
    discovery: {
      topic: "vscode",
      summary: "Show an allowlisted embedded VS Code panel or view.",
      examples: [
        {
          input: {
            panel: "problems",
          },
        },
      ],
      result: "The panel or view shown in embedded VS Code.",
    },
    run: async (input, { host, source }, command): Promise<AppControlResult> => {
      if (source?.kind !== "project-session" || !source.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a parent Project Session Working Directory.",
        };
      const action: VscodeEditorAction = { type: "panel.show", ...input };
      const result = await host.vscode.performEditorAction(source, action);
      return { ok: true, command, result };
    },
  }),
];
