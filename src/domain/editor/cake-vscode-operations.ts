import type { VscodeControl } from "../../contracts/editor/vscode-agent-control";
import { Schema } from "effect";
import { VscodeOpenInput } from "../../contracts/editor/vscode-tool-input";
import { createCakeVscodeSelectionOperations } from "./cake-vscode-selection-operations";

import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import { createCakeVscodeDebugOperations } from "./cake-vscode-debug-operations";

const vscodeEnterInputSchema = Schema.Struct({});
const vscodeScriptInputSchema = Schema.Struct({
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536)),
  input: Schema.optionalKey(Schema.Json),
});

type VscodeScriptInput = typeof vscodeScriptInputSchema.Type;

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
        "Open a file, optionally scrolled to a one-based line. Never selects or highlights code.",
      guidance: [
        "Use vscode.open for file navigation only. It creates no selections, highlights or selection pills.",
        "Use vscode.selections.add to accumulate source ranges or vscode.selections.set to replace the current tour step, including diff context.",
        "Paths may be Working Directory-relative or absolute local paths. External files use the authorized read-only viewer.",
        "Call vscode.enter first; the calling session must be selected.",
        "Explain code in the conversation, not inside the editor.",
      ],
      inputSchema: VscodeOpenInput,
      examples: [{ input: { path: "src/main.ts", line: 55 } }],
      result: "Opened path, optional navigation line and actual view; or VSCODE_MODE_REQUIRED.",
      limitations: ["Call vscode.enter before using this operation."],
      async execute(input, context) {
        const location = Schema.decodeUnknownSync(VscodeOpenInput)(input);
        const result = await control.open(location, context.signal);
        if (result.status === "mode-required") return modeRequired();
        return { opened: true, location: { ...location }, view: result.value.outcome.view };
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
