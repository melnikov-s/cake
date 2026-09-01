import { Schema } from "effect";
import type { JsonObject } from "../../../ipc/json-contract";
import type { SourceLocation, SourcePosition } from "../../../ipc/source-location";
import type { CakeOperationDefinition } from "./cake-operation-registry";

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
type VscodeOpenInput = typeof vscodeOpenInputSchema.Type;

export interface VscodeControl {
  open(location: SourceLocation, signal: AbortSignal): Promise<SourceLocation>;
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

export function createCakeVscodeOperations(
  control: VscodeControl,
): CakeOperationDefinition<VscodeOpenInput>[] {
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
