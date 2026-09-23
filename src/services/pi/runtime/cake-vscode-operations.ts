import { Schema } from "effect";
import type { JsonObject, JsonValue } from "../../../ipc/json-contract";
import { editorLocationFromPath, type EditorLocation } from "../../../ipc/editor-location";
import {
  gitRevisionSchema,
  type SourceLocation,
  type SourcePosition,
} from "../../../ipc/source-location";
import type { VscodeActionResult } from "../../vscode/VsCodeServer";
import type { EditorSelectionOpenResult } from "../../../ipc/editor-selection";
import { agentEditorLocation } from "../../../utils/agent-editor-location";
import {
  createCakeVscodeSelectionOperations,
  type VscodeSelectionControl,
} from "./cake-vscode-selection-operations";
import type { CakeOperationDefinition } from "./cake-operation-registry";
import { createCakeVscodeDebugOperations } from "./cake-vscode-debug-operations";

const coordinate = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000_001 }));
const vscodeOpenInputSchema = Schema.Struct({
  path: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8_192))),
  line: Schema.optionalKey(coordinate),
  column: Schema.optionalKey(coordinate),
  endLine: Schema.optionalKey(coordinate),
  endColumn: Schema.optionalKey(coordinate),
  view: Schema.optionalKey(Schema.Literal("changes")),
  side: Schema.optionalKey(Schema.Literals(["before", "after"])),
  base: Schema.optionalKey(gitRevisionSchema),
}).check(
  Schema.makeFilter((input) => {
    if (input.line === undefined && input.column !== undefined) return "column requires line";
    if (input.line === undefined && input.endLine !== undefined) return "endLine requires line";
    if (input.line === undefined && input.endColumn !== undefined) return "endColumn requires line";
    if (input.endLine !== undefined && input.line !== undefined && input.endLine < input.line)
      return "endLine cannot precede line";
    if (input.side !== undefined && input.view !== "changes") return "side requires changes view";
    if (input.base !== undefined && input.view !== "changes") return "base requires changes view";
    return undefined;
  }),
);
const vscodeEnterInputSchema = Schema.Struct({});
const vscodeScriptInputSchema = Schema.Struct({
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
  input: Schema.optionalKey(Schema.Json),
});

type VscodeOpenInput = typeof vscodeOpenInputSchema.Type;
type VscodeScriptInput = typeof vscodeScriptInputSchema.Type;

export interface VscodeControl extends VscodeSelectionControl {
  enter(signal: AbortSignal): Promise<void>;
  open(
    location: EditorLocation,
    signal: AbortSignal,
  ): Promise<VscodeActionResult<EditorSelectionOpenResult>>;
  runScript(
    source: string,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<VscodeActionResult<JsonValue>>;
}

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

type RevealFallback = NonNullable<EditorSelectionOpenResult["reveal"]["outcome"]["fallback"]>;

function revealFallbackWarning(fallback: RevealFallback, base: string | undefined): string {
  const opened = "VS Code opened the file itself because";
  switch (fallback) {
    case "no-changes":
      return base === undefined
        ? `${opened} it has no uncommitted changes to diff. The changes view compares the working tree with HEAD by default; pass base (for example the branch's merge base) to include committed changes.`
        : `${opened} its working tree does not differ from ${base}.`;
    case "unknown-base":
      return `${opened} Git could not compare it with ${base ?? "HEAD"}; check that the revision exists in this checkout.`;
    case "git-unavailable":
      return `${opened} its Git extension did not report the file's changes in time.`;
  }
}

function openedResult(location: EditorLocation, opened: EditorSelectionOpenResult): JsonObject {
  const { fallback } = opened.reveal.outcome;
  const base = location.kind === "working-directory" ? location.base : undefined;
  const warning = [fallback ? revealFallbackWarning(fallback, base) : undefined, opened.warning]
    .filter(Boolean)
    .join(" ");
  return {
    opened: true,
    location: agentEditorLocation(opened.reveal.locations[0] ?? location),
    view: opened.reveal.outcome.view,
    selectionIds: [...opened.selectionIds],
    ...(warning ? { warning } : null),
  };
}

function modeRequired() {
  return {
    ok: false,
    error: {
      code: "VSCODE_MODE_REQUIRED",
      currentMode: "chat",
      retryable: true,
      recovery: "Select the calling session, call vscode.enter, then retry the same operation.",
    },
  } as const;
}

export function createCakeVscodeOperations(control: VscodeControl): CakeOperationDefinition[] {
  return [
    {
      command: "vscode.enter",
      topic: "vscode",
      summary: "Enter embedded VS Code mode for the calling project.",
      guidance: [
        "Use embedded VS Code proactively for code tours, walkthroughs, visual source navigation, review, and debugging; users do not need to ask for VS Code explicitly.",
        "Enter VS Code mode when the user's request benefits from a visible editor, then invoke the desired VS Code operation.",
        "VS Code actions do not navigate Cake automatically; when they report VSCODE_MODE_REQUIRED, decide whether entering VS Code matches the user's intent.",
      ],
      inputSchema: vscodeEnterInputSchema,
      examples: [{}],
      result: "Confirmation that Cake entered VS Code mode.",
      limitations: ["A Cake window with the calling project open must be available."],
      async execute(_input, context) {
        await control.enter(context.signal);
        return { entered: true };
      },
    },
    {
      command: "vscode.open",
      topic: "vscode",
      summary:
        "Show code by opening a Working Directory or absolute local file in embedded VS Code and highlighting an optional source range.",
      guidance: [
        "Use vscode.open whenever showing code or directing the user's attention, including tours and walkthroughs; pass a source range when specific code should be highlighted.",
        "Do not recreate source opening or selection with vscode.script.run; reserve scripts for layout or interactions that vscode.open cannot express.",
        "Use filesystem tools to read or edit files; vscode.open is the visual presentation operation.",
        "Ranged opens accumulate session-local selection pills. They remain until removed/cleared or the session Store/window closes, and are not persisted across Cake restarts.",
        "Use vscode.selections.list to inspect IDs, vscode.selections.remove for one selection, or vscode.selections.clear before the next tour step.",
        "Opening code requires the calling session to be selected; background sessions never replace the active session's highlights.",
        "Paths may be relative to the Project Session's Working Directory or absolute local file paths.",
        "Opening an absolute path does not add it to the project or change the Working Directory.",
        "Explain the location in the normal Cake conversation. Do not duplicate the explanation inside the editor.",
        "In Project Session responses, source links such as [request handling](src/main.ts#L55-L64) are clickable and open with the exact range marked without selecting its text.",
        "Join disjoint ranges with commas in one source link, for example [related handlers](src/main.ts#L55-L64,L92-L108).",
        "To link an exact range in VS Code's native diff editor, use [changed request handling](src/main.ts?view=changes#L55-L64) for the after side or [previous request handling](src/main.ts?view=changes&side=before#L55-L64) for the before side.",
        "Set view to changes to open this operation's range in the native diff editor; its side defaults to after.",
        "The changes view compares the working tree with base, which defaults to HEAD and therefore shows uncommitted changes only. To show committed work as well, set base to a single revision such as main, origin/main, HEAD~1, a merge base, or a SHA; links accept the same as [what this branch changed](src/main.ts?view=changes&base=main#L55-L64).",
        "When the file does not differ from base, or base cannot be resolved, VS Code opens the file itself and the result reports view file with a warning; tell the user when that happens.",
        "Lines and columns in this operation are one-based.",
      ],
      inputSchema: vscodeOpenInputSchema,
      examples: [
        {
          input: {
            path: "src/main/main.ts",
            line: 804,
            column: 5,
            endLine: 812,
            endColumn: 6,
            view: "changes",
            side: "after",
          },
        },
        {
          input: {
            path: "src/main/main.ts",
            line: 804,
            endLine: 812,
            view: "changes",
            base: "main",
          },
          description:
            "Diff the working tree against the main branch, including committed changes.",
        },
        { input: { path: "/tmp/cake.log" }, description: "Open an absolute local file." },
      ],
      result:
        "The resolved location, selectionIds (empty for file-only navigation), the actual view, and any diff fallback or highlight warning; or VSCODE_MODE_REQUIRED when the calling session is not selected in VS Code mode.",
      limitations: ["Call vscode.enter before using this operation."],
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed this value with vscodeOpenInputSchema.
        const location = editorLocationFromPath(sourceLocation(input as VscodeOpenInput));
        const result = await control.open(location, context.signal);
        if (result.status === "mode-required") return modeRequired();
        return openedResult(location, result.value);
      },
    },
    {
      command: "vscode.script.run",
      topic: "vscode",
      summary: "Run one arbitrary JavaScript action inside VS Code's extension host.",
      guidance: [
        "The script body runs as an async function with vscode, input, and require arguments available; return a JSON-compatible value.",
        "Use vscode APIs for editor layout, navigation, commands, terminals, prompts, decorations, and installed-extension workflows.",
        "This is trusted unrestricted extension-host code. Prefer a focused one-shot action and avoid leaving commands, providers, listeners, or timers registered.",
      ],
      inputSchema: vscodeScriptInputSchema,
      examples: [
        {
          description: "Open two workspace files side-by-side.",
          input: {
            source:
              "const root = vscode.workspace.workspaceFolders[0].uri;\nconst left = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, input.left));\nawait vscode.window.showTextDocument(left, { viewColumn: vscode.ViewColumn.One, preview: false });\nconst right = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, input.right));\nawait vscode.window.showTextDocument(right, { viewColumn: vscode.ViewColumn.Two, preview: false });\nreturn { opened: [input.left, input.right] };",
            input: { left: "src/main.ts", right: "tests/main.test.ts" },
          },
        },
      ],
      result:
        "The script's JSON-compatible return value, or VSCODE_MODE_REQUIRED when VS Code mode is inactive.",
      limitations: [
        "Call vscode.enter before using this operation.",
        "A script can modify files and settings, invoke extensions, start processes, or destabilize the shared extension host.",
        "Transport cancellation cannot forcibly stop synchronous or non-cooperative JavaScript already running in the extension host.",
      ],
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed this value with vscodeScriptInputSchema.
        const script = input as VscodeScriptInput;
        const result = await control.runScript(script.source, script.input ?? null, context.signal);
        if (result.status === "mode-required") return modeRequired();
        return { ok: true, result: result.value };
      },
    },
    ...createCakeVscodeSelectionOperations(control),
    ...createCakeVscodeDebugOperations(control),
  ];
}
