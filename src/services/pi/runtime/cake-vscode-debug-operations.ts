import { Schema } from "effect";
import { jsonObjectSchema, jsonValueSchema, type JsonValue } from "../../../ipc/json-contract";
import type { VscodeActionResult } from "../../vscode/VsCodeServer";
import type { CakeOperationDefinition } from "./cake-operation-registry";

interface VscodeDebugControl {
  runScript(
    source: string,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<VscodeActionResult<JsonValue>>;
}

const name = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(512)));
const path = Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(8_192)));
const expression = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384));
const positiveInt = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 }));
const nonNegativeInt = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_147_483_647 }));
const boundedCount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));

const startInputSchema = Schema.Struct({
  configuration: Schema.Union([name, jsonObjectSchema]),
  workspaceFolder: Schema.optionalKey(name),
  noDebug: Schema.optionalKey(Schema.Boolean),
});

const setBreakpointInputSchema = Schema.Struct({
  path,
  line: positiveInt,
  column: Schema.optionalKey(positiveInt),
  enabled: Schema.optionalKey(Schema.Boolean),
  condition: Schema.optionalKey(expression),
  hitCondition: Schema.optionalKey(name),
  logMessage: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
});

const clearBreakpointsInputSchema = Schema.Struct({
  path: Schema.optionalKey(path),
  line: Schema.optionalKey(positiveInt),
  column: Schema.optionalKey(positiveInt),
}).check(
  Schema.makeFilter((input) => {
    if (input.path === undefined && input.line !== undefined) return "line requires path";
    if (input.line === undefined && input.column !== undefined) return "column requires line";
    return undefined;
  }),
);

const stackInputSchema = Schema.Struct({
  threadId: Schema.optionalKey(positiveInt),
  startFrame: Schema.optionalKey(nonNegativeInt),
  levels: Schema.optionalKey(boundedCount),
});

const scopesInputSchema = Schema.Struct({ frameId: nonNegativeInt });
const variablesInputSchema = Schema.Struct({
  variablesReference: nonNegativeInt,
  filter: Schema.optionalKey(Schema.Literals(["indexed", "named"])),
  start: Schema.optionalKey(nonNegativeInt),
  count: Schema.optionalKey(boundedCount),
});
const evaluateInputSchema = Schema.Struct({
  expression,
  frameId: Schema.optionalKey(nonNegativeInt),
  context: Schema.optionalKey(Schema.Literals(["watch", "repl", "hover", "clipboard"])),
});
const controlInputSchema = Schema.Struct({
  action: Schema.Literals(["pause", "continue", "next", "stepIn", "stepOut"]),
  threadId: positiveInt,
  singleThread: Schema.optionalKey(Schema.Boolean),
  granularity: Schema.optionalKey(Schema.Literals(["statement", "line", "instruction"])),
});
const emptyInputSchema = Schema.Struct({});

const activeSessionSource = `
const session = vscode.debug.activeDebugSession;
if (!session) {
  return { ok: false, error: { code: "NO_ACTIVE_DEBUG_SESSION", message: "No VS Code debug session is active." } };
}
const boundedText = (value, maximum = 4096) => typeof value === "string" && value.length > maximum ? value.slice(0, maximum) + "…" : value;
const sessionInfo = (value) => ({ id: value.id, name: boundedText(value.name), type: value.type, workspaceFolder: value.workspaceFolder?.name });
const sourceInfo = (source) => source ? { name: boundedText(source.name), path: boundedText(source.path, 8192), sourceReference: source.sourceReference } : undefined;
`;

const startSource = `
const folders = vscode.workspace.workspaceFolders || [];
let folder = folders[0];
if (input.workspaceFolder) {
  folder = folders.find((candidate) => candidate.name === input.workspaceFolder || candidate.uri.fsPath === input.workspaceFolder);
  if (!folder) {
    return { ok: false, error: { code: "WORKSPACE_FOLDER_NOT_FOUND", message: "The requested VS Code workspace folder is not open." } };
  }
}
if (!folder) {
  return { ok: false, error: { code: "NO_WORKSPACE_FOLDER", message: "VS Code has no open workspace folder." } };
}
const options = input.noDebug === undefined ? undefined : { noDebug: input.noDebug };
const started = await vscode.debug.startDebugging(folder, input.configuration, options);
const session = vscode.debug.activeDebugSession;
return {
  ok: started,
  started,
  session: session ? { id: session.id, name: session.name, type: session.type, workspaceFolder: session.workspaceFolder?.name } : null,
  ...(started ? {} : { error: { code: "DEBUG_START_REJECTED", message: "VS Code did not start the debug session." } }),
};
`;

const statusSource = `
const boundedText = (value, maximum = 4096) => typeof value === "string" && value.length > maximum ? value.slice(0, maximum) + "…" : value;
const serializeBreakpoint = (breakpoint) => {
  if (breakpoint instanceof vscode.SourceBreakpoint) {
    return {
      kind: "source",
      path: boundedText(vscode.workspace.asRelativePath(breakpoint.location.uri, false), 8192),
      line: breakpoint.location.range.start.line + 1,
      column: breakpoint.location.range.start.character + 1,
      enabled: breakpoint.enabled,
      condition: boundedText(breakpoint.condition),
      hitCondition: boundedText(breakpoint.hitCondition),
      logMessage: boundedText(breakpoint.logMessage),
    };
  }
  if (breakpoint instanceof vscode.FunctionBreakpoint) {
    return { kind: "function", functionName: boundedText(breakpoint.functionName), enabled: breakpoint.enabled, condition: boundedText(breakpoint.condition), hitCondition: boundedText(breakpoint.hitCondition), logMessage: boundedText(breakpoint.logMessage) };
  }
  return { kind: "other", enabled: breakpoint.enabled };
};
const session = vscode.debug.activeDebugSession;
return {
  ok: true,
  active: Boolean(session),
  session: session ? { id: session.id, name: boundedText(session.name), type: session.type, workspaceFolder: session.workspaceFolder?.name } : null,
  breakpointCount: vscode.debug.breakpoints.length,
  breakpoints: vscode.debug.breakpoints.slice(0, 500).map(serializeBreakpoint),
};
`;

const setBreakpointSource = `
const folders = vscode.workspace.workspaceFolders || [];
const root = folders[0];
if (!root) return { ok: false, error: { code: "NO_WORKSPACE_FOLDER", message: "VS Code has no open workspace folder." } };
const uri = vscode.Uri.joinPath(root.uri, input.path);
if (vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== root.uri.toString()) {
  return { ok: false, error: { code: "PATH_OUTSIDE_WORKSPACE", message: "The breakpoint path is outside the workspace folder." } };
}
const location = new vscode.Location(uri, new vscode.Position(input.line - 1, (input.column || 1) - 1));
const breakpoint = new vscode.SourceBreakpoint(location, input.enabled ?? true, input.condition, input.hitCondition, input.logMessage);
vscode.debug.addBreakpoints([breakpoint]);
return { ok: true, breakpoint: { path: vscode.workspace.asRelativePath(uri, false), line: input.line, column: input.column || 1, enabled: breakpoint.enabled } };
`;

const clearBreakpointsSource = `
let targetUri;
if (input.path) {
  const root = (vscode.workspace.workspaceFolders || [])[0];
  if (!root) return { ok: false, error: { code: "NO_WORKSPACE_FOLDER", message: "VS Code has no open workspace folder." } };
  targetUri = vscode.Uri.joinPath(root.uri, input.path);
  if (vscode.workspace.getWorkspaceFolder(targetUri)?.uri.toString() !== root.uri.toString()) {
    return { ok: false, error: { code: "PATH_OUTSIDE_WORKSPACE", message: "The breakpoint path is outside the workspace folder." } };
  }
}
const matches = vscode.debug.breakpoints.filter((breakpoint) => {
  if (!targetUri) return true;
  if (!(breakpoint instanceof vscode.SourceBreakpoint)) return false;
  if (breakpoint.location.uri.toString() !== targetUri.toString()) return false;
  if (input.line !== undefined && breakpoint.location.range.start.line !== input.line - 1) return false;
  if (input.column !== undefined && breakpoint.location.range.start.character !== input.column - 1) return false;
  return true;
});
vscode.debug.removeBreakpoints(matches);
return { ok: true, removed: matches.length };
`;

const stackSource = `${activeSessionSource}
const threadResponse = await session.customRequest("threads");
const threads = Array.isArray(threadResponse?.threads) ? threadResponse.threads : [];
const selected = input.threadId === undefined ? threads.slice(0, 20) : threads.filter((thread) => thread.id === input.threadId);
if (input.threadId !== undefined && selected.length === 0) {
  return { ok: false, error: { code: "THREAD_NOT_FOUND", message: "The requested debug thread was not found." }, session: sessionInfo(session), threads: threads.slice(0, 20).map((thread) => ({ id: thread.id, name: boundedText(thread.name) })) };
}
const results = [];
for (const thread of selected) {
  try {
    const response = await session.customRequest("stackTrace", { threadId: thread.id, startFrame: input.startFrame || 0, levels: input.levels || 50 });
    const stackFrames = (response?.stackFrames || []).slice(0, input.levels || 50).map((frame) => ({
      id: frame.id,
      name: boundedText(frame.name),
      source: sourceInfo(frame.source),
      line: frame.line,
      column: frame.column,
      endLine: frame.endLine,
      endColumn: frame.endColumn,
      moduleId: frame.moduleId,
      presentationHint: frame.presentationHint,
      canRestart: frame.canRestart,
      instructionPointerReference: frame.instructionPointerReference,
    }));
    results.push({ id: thread.id, name: boundedText(thread.name), stackFrames, totalFrames: response?.totalFrames });
  } catch (error) {
    results.push({ id: thread.id, name: boundedText(thread.name), error: boundedText(error instanceof Error ? error.message : String(error)) });
  }
}
return { ok: true, session: sessionInfo(session), threads: results };
`;

const scopesSource = `${activeSessionSource}
const response = await session.customRequest("scopes", { frameId: input.frameId });
const scopes = (response?.scopes || []).slice(0, 100).map((scope) => ({
  name: boundedText(scope.name),
  presentationHint: scope.presentationHint,
  variablesReference: scope.variablesReference,
  namedVariables: scope.namedVariables,
  indexedVariables: scope.indexedVariables,
  expensive: scope.expensive,
  source: sourceInfo(scope.source),
  line: scope.line,
  column: scope.column,
  endLine: scope.endLine,
  endColumn: scope.endColumn,
}));
return { ok: true, session: sessionInfo(session), frameId: input.frameId, scopes };
`;

const variablesSource = `${activeSessionSource}
const args = { variablesReference: input.variablesReference, start: input.start || 0, count: input.count || 100 };
if (input.filter) args.filter = input.filter;
const response = await session.customRequest("variables", args);
const variables = (response?.variables || []).slice(0, input.count || 100).map((variable) => ({
  name: boundedText(variable.name),
  value: boundedText(variable.value),
  type: boundedText(variable.type),
  evaluateName: boundedText(variable.evaluateName),
  variablesReference: variable.variablesReference,
  namedVariables: variable.namedVariables,
  indexedVariables: variable.indexedVariables,
  memoryReference: variable.memoryReference,
}));
return { ok: true, session: sessionInfo(session), variablesReference: input.variablesReference, variables };
`;

const evaluateSource = `${activeSessionSource}
const args = { expression: input.expression, context: input.context || "repl" };
if (input.frameId !== undefined) args.frameId = input.frameId;
const response = await session.customRequest("evaluate", args);
return {
  ok: true,
  session: sessionInfo(session),
  result: boundedText(response?.result, 65536),
  type: boundedText(response?.type),
  presentationHint: response?.presentationHint,
  variablesReference: response?.variablesReference,
  namedVariables: response?.namedVariables,
  indexedVariables: response?.indexedVariables,
  memoryReference: response?.memoryReference,
};
`;

const controlSource = `${activeSessionSource}
const args = { threadId: input.threadId };
if (input.action !== "pause" && input.singleThread !== undefined) args.singleThread = input.singleThread;
if (["next", "stepIn", "stepOut"].includes(input.action) && input.granularity) args.granularity = input.granularity;
const response = await session.customRequest(input.action, args);
return { ok: true, session: sessionInfo(session), action: input.action, response: response ?? null };
`;

const stopSource = `${activeSessionSource}
const stopped = await vscode.debug.stopDebugging(session);
return { ok: stopped, stopped, session: sessionInfo(session), ...(stopped ? {} : { error: { code: "DEBUG_STOP_REJECTED", message: "VS Code did not stop the debug session." } }) };
`;

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

async function runDebugScript(
  control: VscodeDebugControl,
  source: string,
  input: unknown,
  signal: AbortSignal,
) {
  const jsonInput = Schema.decodeUnknownSync(jsonValueSchema)(input);
  const result = await control.runScript(source, jsonInput, signal);
  return result.status === "mode-required" ? modeRequired() : result.value;
}

export function createCakeVscodeDebugOperations(
  control: VscodeDebugControl,
): CakeOperationDefinition[] {
  const guidance = [
    "Debugger operations use the active VS Code debug adapter and require VS Code mode.",
    "Start with vscode.debug.status, then inspect a paused session with stack, scopes, and variables.",
    "Do not evaluate expressions that may have side effects without the user's approval.",
  ];
  const limitation = ["Call vscode.enter before using this operation."];

  return [
    {
      command: "vscode.debug.start",
      topic: "vscode",
      summary: "Start a VS Code debug configuration.",
      guidance,
      inputSchema: startInputSchema,
      examples: [{ input: { configuration: "Debug Current Test" } }],
      result: "Whether VS Code started debugging and the active debug-session identity.",
      limitations: [...limitation, "The corresponding language debug adapter must be installed."],
      execute: (input, context) => runDebugScript(control, startSource, input, context.signal),
    },
    {
      command: "vscode.debug.status",
      topic: "vscode",
      summary: "Inspect the active debug session and configured breakpoints.",
      guidance,
      inputSchema: emptyInputSchema,
      examples: [{}],
      result: "The active debug-session identity and normalized breakpoint list.",
      limitations: limitation,
      execute: (input, context) => runDebugScript(control, statusSource, input, context.signal),
    },
    {
      command: "vscode.debug.setBreakpoint",
      topic: "vscode",
      summary: "Add a source breakpoint or logpoint.",
      guidance,
      inputSchema: setBreakpointInputSchema,
      examples: [{ input: { path: "src/main.ts", line: 42 } }],
      result: "The normalized breakpoint location.",
      limitations: limitation,
      execute: (input, context) =>
        runDebugScript(control, setBreakpointSource, input, context.signal),
    },
    {
      command: "vscode.debug.clearBreakpoints",
      topic: "vscode",
      summary:
        "Remove matching source breakpoints, or every breakpoint when no location is supplied.",
      guidance,
      inputSchema: clearBreakpointsInputSchema,
      examples: [{ input: { path: "src/main.ts", line: 42 } }],
      result: "The number of removed breakpoints.",
      limitations: limitation,
      execute: (input, context) =>
        runDebugScript(control, clearBreakpointsSource, input, context.signal),
    },
    {
      command: "vscode.debug.stack",
      topic: "vscode",
      summary: "Read threads and bounded stack traces from the active debug session.",
      guidance,
      inputSchema: stackInputSchema,
      examples: [{ input: { threadId: 1, levels: 20 } }],
      result: "Debug threads with their current stack frames.",
      limitations: [...limitation, "Stack traces generally require the target to be paused."],
      execute: (input, context) => runDebugScript(control, stackSource, input, context.signal),
    },
    {
      command: "vscode.debug.scopes",
      topic: "vscode",
      summary: "Read scopes for a paused stack frame.",
      guidance,
      inputSchema: scopesInputSchema,
      examples: [{ input: { frameId: 7 } }],
      result: "Scopes and variable references for the requested stack frame.",
      limitations: limitation,
      execute: (input, context) => runDebugScript(control, scopesSource, input, context.signal),
    },
    {
      command: "vscode.debug.variables",
      topic: "vscode",
      summary: "Read a bounded page of debugger variables.",
      guidance,
      inputSchema: variablesInputSchema,
      examples: [{ input: { variablesReference: 12, count: 100 } }],
      result: "Variables for the requested debugger variable reference.",
      limitations: limitation,
      execute: (input, context) => runDebugScript(control, variablesSource, input, context.signal),
    },
    {
      command: "vscode.debug.evaluate",
      topic: "vscode",
      summary: "Evaluate an expression in the active debug session.",
      guidance,
      inputSchema: evaluateInputSchema,
      examples: [{ input: { expression: "user.id", frameId: 7, context: "watch" } }],
      result: "The debug adapter's evaluation result and optional expandable variable reference.",
      limitations: [...limitation, "Evaluation can execute code in the debug target."],
      execute: (input, context) => runDebugScript(control, evaluateSource, input, context.signal),
    },
    {
      command: "vscode.debug.control",
      topic: "vscode",
      summary: "Pause, continue, or step a debug thread.",
      guidance,
      inputSchema: controlInputSchema,
      examples: [{ input: { action: "next", threadId: 1 } }],
      result: "Confirmation that the debug adapter accepted the control request.",
      limitations: limitation,
      execute: (input, context) => runDebugScript(control, controlSource, input, context.signal),
    },
    {
      command: "vscode.debug.stop",
      topic: "vscode",
      summary: "Stop the active VS Code debug session.",
      guidance,
      inputSchema: emptyInputSchema,
      examples: [{}],
      result: "Whether VS Code stopped the active debug session.",
      limitations: limitation,
      execute: (input, context) => runDebugScript(control, stopSource, input, context.signal),
    },
  ];
}
