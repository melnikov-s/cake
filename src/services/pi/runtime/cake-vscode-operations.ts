import { Schema } from "effect";
import type { JsonObject, JsonValue } from "../../../ipc/json-contract";
import type { SourceLocation, SourcePosition } from "../../../ipc/source-location";
import type { VscodeActionResult } from "../../vscode/VsCodeServer";
import type { CakeOperationDefinition } from "./cake-operation-registry";
import { createCakeVscodeDebugOperations } from "./cake-vscode-debug-operations";

const coordinate = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000_001 }));
const vscodeOpenInputSchema = Schema.Struct({
  path: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8_192))),
  line: Schema.optionalKey(coordinate),
  column: Schema.optionalKey(coordinate),
  endLine: Schema.optionalKey(coordinate),
  endColumn: Schema.optionalKey(coordinate),
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
const vscodeEnterInputSchema = Schema.Struct({});
const vscodeScriptInputSchema = Schema.Struct({
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
  input: Schema.optionalKey(Schema.Json),
});

type VscodeOpenInput = typeof vscodeOpenInputSchema.Type;
type VscodeScriptInput = typeof vscodeScriptInputSchema.Type;

export interface VscodeControl {
  enter(signal: AbortSignal): Promise<void>;
  open(location: SourceLocation, signal: AbortSignal): Promise<VscodeActionResult<SourceLocation>>;
  runScript(
    source: string,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<VscodeActionResult<JsonValue>>;
}

function sourceLocation(input: VscodeOpenInput): SourceLocation {
  if (input.line === undefined) return { path: input.path };
  const start: SourcePosition =
    input.column === undefined
      ? { line: input.line - 1 }
      : { line: input.line - 1, column: input.column - 1 };
  const end: SourcePosition =
    input.endColumn === undefined
      ? { line: (input.endLine ?? input.line) - 1 }
      : { line: (input.endLine ?? input.line) - 1, column: input.endColumn - 1 };
  return { path: input.path, range: { start, end } };
}

interface AgentLocation {
  path: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

function agentLocation(location: SourceLocation): JsonObject {
  const result: AgentLocation = { path: location.path };
  if (!location.range) return { ...result };
  result.line = location.range.start.line + 1;
  if (location.range.start.column !== undefined) result.column = location.range.start.column + 1;
  if (location.range.end !== undefined) {
    result.endLine = location.range.end.line + 1;
    if (location.range.end.column !== undefined) result.endColumn = location.range.end.column + 1;
  }
  return { ...result };
}

function modeRequired() {
  return {
    ok: false,
    error: {
      code: "VSCODE_MODE_REQUIRED",
      currentMode: "chat",
      retryable: true,
      recovery: "Call vscode.enter, then retry the same operation.",
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
      summary: "Open a workspace file in embedded VS Code and highlight an optional source range.",
      guidance: [
        "Use this operation to direct the user's attention in embedded VS Code; use filesystem tools to read or edit files.",
        "Explain the location in the normal Cake conversation. Do not duplicate the explanation inside the editor.",
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
          },
        },
      ],
      result:
        "The normalized workspace-relative location, or VSCODE_MODE_REQUIRED when VS Code mode is inactive.",
      limitations: ["Call vscode.enter before using this operation."],
      async execute(input, context) {
        // SAFETY: CakeOperationRegistry parsed this value with vscodeOpenInputSchema.
        const result = await control.open(sourceLocation(input as VscodeOpenInput), context.signal);
        if (result.status === "mode-required") return modeRequired();
        return { opened: true, location: agentLocation(result.value) };
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
    ...createCakeVscodeDebugOperations(control),
  ];
}
