import { Schema } from "effect";
import type { VscodeEditorAction } from "../../contracts/vscode/vscode-editor-action";
import { EditorSelectionId } from "../../contracts/editor/editor-selection";
import {
  VscodeOpenInput,
  VscodeSelectionsInput,
  navigationEditorLocation,
  selectionEditorLocation,
} from "../../contracts/editor/vscode-tool-input";
import type { AppControlResult } from "./app-control-data";
import { trimmed, emptyArgumentsSchema } from "./control-arguments";
import { defineControl } from "./control-definition";
export const vscodeControls = [
  ...(["vscode.selections.add", "vscode.selections.set"] as const).map((command) =>
    defineControl({
      command,
      args: VscodeSelectionsInput,
      scope: "session-assistant",
      discovery: {
        topic: "vscode",
        summary: command.endsWith(".add")
          ? "Append source selections to the calling session."
          : "Replace the calling session's source selections.",
        guidance: [
          "One-based source ranges, with optional changes view, side and base. All locations resolve before state changes. Empty set clears; empty add is a no-op.",
        ],
        result:
          "The updated selection state, requested IDs, resolved reveals and any projection warning.",
      },
      run: async (input, { host, source }, operation): Promise<AppControlResult> => {
        if (!source?.workingDirectory)
          return {
            ok: false,
            command: operation,
            error: "Embedded VS Code requires a Project Chat or Project Session Working Directory.",
          };
        const update = await host.vscode.writeSelections(
          source,
          input.selections.map(selectionEditorLocation),
          operation === "vscode.selections.set",
        );
        return { ok: true, command: operation, update };
      },
    }),
  ),
  defineControl({
    command: "vscode.selections.list",
    args: Schema.Struct({}),
    scope: "session-assistant",
    discovery: {
      topic: "vscode",
      summary: "List the parent session's code-tour selections.",
      guidance: [
        "Use vscode.selections.add to accumulate ranges or vscode.selections.set to replace the current tour step.",
        "Selection state is ephemeral and not persisted across Cake restarts. List/remove/clear work while VS Code is hidden.",
      ],
    },
    run: async (_input, { host, source }, command): Promise<AppControlResult> => {
      if (!source?.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a Project Chat or Project Session Working Directory.",
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
        "Use vscode.selections.add to accumulate ranges or vscode.selections.set to replace the current tour step.",
        "Selection state is ephemeral and not persisted across Cake restarts. List/remove/clear work while VS Code is hidden.",
      ],
    },
    run: async (input, { host, source }, command): Promise<AppControlResult> => {
      if (!source?.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a Project Chat or Project Session Working Directory.",
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
        "Use vscode.selections.add to accumulate ranges or vscode.selections.set to replace the current tour step.",
        "Selection state is ephemeral and not persisted across Cake restarts. List/remove/clear work while VS Code is hidden.",
      ],
    },
    run: async (_input, { host, source }, command): Promise<AppControlResult> => {
      if (!source?.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a Project Chat or Project Session Working Directory.",
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
      if (!source?.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a Project Chat or Project Session Working Directory.",
        };
      await host.vscode.enter(source);
      return { ok: true, command, entered: true };
    },
  }),
  defineControl({
    command: "vscode.open",
    args: VscodeOpenInput,
    scope: "session-assistant",
    discovery: {
      topic: "vscode",
      summary:
        "Open a file, optionally at a one-based line; never creates selections or highlights.",
      guidance: [
        "Use vscode.selections.add/set for source ranges and diff context. Call vscode.enter first.",
      ],
      examples: [{ input: { path: "src/main.ts", line: 1 } }],
      result: "The opened location and navigation outcome.",
    },
    run: async (input, { host, source }, command): Promise<AppControlResult> => {
      if (!source?.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a Project Chat or Project Session Working Directory.",
        };
      const location = navigationEditorLocation(input);
      const reveal = await host.vscode.open(source, location);
      return { ok: true, command, opened: location, reveal };
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
      if (!source?.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a Project Chat or Project Session Working Directory.",
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
      if (!source?.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a Project Chat or Project Session Working Directory.",
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
      if (!source?.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a Project Chat or Project Session Working Directory.",
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
      if (!source?.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a Project Chat or Project Session Working Directory.",
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
      if (!source?.workingDirectory)
        return {
          ok: false,
          command,
          error: "Embedded VS Code requires a Project Chat or Project Session Working Directory.",
        };
      const action: VscodeEditorAction = { type: "panel.show", ...input };
      const result = await host.vscode.performEditorAction(source, action);
      return { ok: true, command, result };
    },
  }),
];
