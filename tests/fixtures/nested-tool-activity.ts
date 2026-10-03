import type { AssistantMessage, NestedToolCalls, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const nestedScript =
  "const results = await Promise.allSettled([\n  tools.read({ path: 'a.ts' }),\n  tools.read({ path: 'b.ts' }),\n  tools.write({ path: 'large.ts', content: 'x'.repeat(9000) }),\n]);\nreturn results;";
export const nestedLargeArguments = { path: "large.ts", content: "x".repeat(9000) };
export const nestedArgumentBytes = new TextEncoder().encode(
  JSON.stringify(nestedLargeArguments),
).length;
export const nestedUsage = {
  input: 12,
  output: 3,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};
export const nestedSummary: NestedToolCalls = {
  complete: false,
  calls: [
    { id: "script/1", name: "read", arguments: { path: "a.ts" }, status: "ok", durationMs: 15 },
    {
      id: "script/2",
      name: "read",
      arguments: { path: "b.ts" },
      status: "error",
      error: "Read cancelled",
      durationMs: 20,
    },
    { id: "script/3", name: "write", argumentsBytes: nestedArgumentBytes, status: "unfinished" },
  ],
};
export const nestedAssistant: AssistantMessage = {
  role: "assistant",
  content: [
    { type: "toolCall", id: "script", name: "codemode", arguments: { code: nestedScript } },
  ],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "fixture",
  usage: nestedUsage,
  stopReason: "toolUse",
  timestamp: 1,
};
export const nestedResult: ToolResultMessage = {
  role: "toolResult",
  toolCallId: "script",
  toolName: "codemode",
  content: [{ type: "text", text: "Script failed\nPartial result\nScript error: cancelled" }],
  nestedCalls: nestedSummary,
  usage: nestedUsage,
  isError: true,
  timestamp: 2,
};
export function nestedEntries(): SessionEntry[] {
  return [
    {
      type: "message",
      id: "assistant",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: nestedAssistant,
    },
    {
      type: "message",
      id: "result",
      parentId: "assistant",
      timestamp: new Date(2).toISOString(),
      message: nestedResult,
    },
  ];
}
