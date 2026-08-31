import { z } from "zod";
import type { JsonObject } from "../../../ipc/json-contract";
import type { SourceLocation, SourcePosition } from "../../../ipc/source-location";
import type { CakeOperationDefinition } from "./cake-operation-registry";

const vscodeOpenInputSchema = z
  .object({
    path: z.string().trim().min(1).max(8_192).describe("Workspace-relative file path."),
    line: z.number().int().min(1).max(10_000_001).optional().describe("One-based start line."),
    column: z.number().int().min(1).max(10_000_001).optional().describe("One-based start column."),
    endLine: z.number().int().min(1).max(10_000_001).optional().describe("One-based end line."),
    endColumn: z
      .number()
      .int()
      .min(1)
      .max(10_000_001)
      .optional()
      .describe("One-based exclusive end column."),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.line === undefined && input.column !== undefined)
      context.addIssue({ code: "custom", path: ["column"], message: "column requires line" });
    if (input.line === undefined && input.endLine !== undefined)
      context.addIssue({ code: "custom", path: ["endLine"], message: "endLine requires line" });
    if (input.line === undefined && input.endColumn !== undefined)
      context.addIssue({
        code: "custom",
        path: ["endColumn"],
        message: "endColumn requires line",
      });
    if (input.endLine !== undefined && input.line !== undefined && input.endLine < input.line)
      context.addIssue({
        code: "custom",
        path: ["endLine"],
        message: "endLine cannot precede line",
      });
  });

export interface VscodeControl {
  open(location: SourceLocation, signal: AbortSignal): Promise<SourceLocation>;
}

function sourceLocation(input: z.infer<typeof vscodeOpenInputSchema>): SourceLocation {
  if (input.line === undefined) return { path: input.path };
  const start: SourcePosition = { line: input.line - 1 };
  if (input.column !== undefined) start.column = input.column - 1;
  const end: SourcePosition = { line: (input.endLine ?? input.line) - 1 };
  if (input.endColumn !== undefined) end.column = input.endColumn - 1;
  return { path: input.path, range: { start, end } };
}

function agentLocation(location: SourceLocation) {
  const result: JsonObject = { path: location.path };
  if (!location.range) return result;
  result.line = location.range.start.line + 1;
  if (location.range.start.column !== undefined) result.column = location.range.start.column + 1;
  if (location.range.end) {
    result.endLine = location.range.end.line + 1;
    if (location.range.end.column !== undefined) result.endColumn = location.range.end.column + 1;
  }
  return result;
}

export function createCakeVscodeOperations(
  control: VscodeControl,
): CakeOperationDefinition<z.infer<typeof vscodeOpenInputSchema>>[] {
  return [
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
      result: "The normalized workspace-relative location opened in embedded VS Code.",
      limitations: ["A Cake window with the calling project open must be available."],
      async execute(input, context) {
        const opened = await control.open(sourceLocation(input), context.signal);
        return { opened: true, location: agentLocation(opened) };
      },
    },
  ];
}
