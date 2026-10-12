import type { NestedToolCall, UiPart } from "../../../contracts/conversations/session-contract";
import { boundedProjectionKey, projectNestedToolCalls } from "./session-projection";

type ToolPart = Extract<UiPart, { kind: "tool" }>;

/**
 * Per-turn display bookkeeping, not a tool runtime or durable transcript cache.
 * Pi starts parents before children. Explicit live relationships resolve to the
 * model-issued root, matching Pi's flat durable summary without parsing IDs.
 */
export function createNestedToolActivityProjection(emit: (part: ToolPart) => void) {
  const roots = new Map<string, string>();
  const parts = new Map<string, ToolPart>();

  const project = (part: ToolPart, parentToolCallId?: string) => {
    if (!parentToolCallId) {
      roots.set(part.id, part.id);
      const previous = parts.get(part.id);
      const next = previous?.nestedCalls ? { ...part, nestedCalls: previous.nestedCalls } : part;
      parts.set(part.id, next);
      emit(next);
      return;
    }
    const rootId = roots.get(boundedProjectionKey(`tool-${parentToolCallId}`));
    const root = rootId ? parts.get(rootId) : undefined;
    if (!root || !rootId) return;
    roots.set(part.id, rootId);
    const calls = [...(root.nestedCalls?.calls ?? [])];
    const index = calls.findIndex((call) => call.id === part.id);
    const dropped = index < 0 && calls.length >= 256;
    const child: NestedToolCall = {
      id: part.id,
      name: part.name,
      command: part.command,
      input: part.input,
      output: part.output,
      outputContent: part.outputContent,
      filePath: part.filePath,
      diff: part.diff,
      state: part.state,
      outputAvailability: "live",
      inputUnavailable: false,
    };
    if (index >= 0) calls[index] = { ...calls[index], ...child };
    else if (!dropped) calls.push(child);
    const nestedCalls = { ...root.nestedCalls, calls };
    if (dropped) nestedCalls.complete = false;
    const next = { ...root, nestedCalls };
    parts.set(rootId, next);
    emit(next);
  };

  const record = (toolCallId: string, summary: unknown) => {
    const rootId = boundedProjectionKey(`tool-${toolCallId}`);
    const root = parts.get(rootId);
    const persisted = projectNestedToolCalls(summary);
    if (!root || !persisted) return;
    const live = new Map(root.nestedCalls?.calls.map((call) => [call.id, call]));
    const next = {
      ...root,
      nestedCalls: {
        ...persisted,
        // Keep observed output until the authoritative settled snapshot replaces it.
        calls: persisted.calls.map((call) => {
          const nextCall = { ...call, ...live.get(call.id), state: call.state };
          if (call.durationMs !== undefined) nextCall.durationMs = call.durationMs;
          if (call.errorSummary !== undefined) nextCall.errorSummary = call.errorSummary;
          return nextCall;
        }),
      },
    };
    parts.set(rootId, next);
    emit(next);
  };

  const clear = () => {
    roots.clear();
    parts.clear();
  };
  const settle = () => {
    for (const root of parts.values()) {
      if (!root.nestedCalls?.calls.some((call) => call.state === "running")) continue;
      emit({
        ...root,
        nestedCalls: {
          ...root.nestedCalls,
          complete: false,
          calls: root.nestedCalls.calls.map((call) =>
            call.state === "running" ? { ...call, state: "interrupted" } : call,
          ),
        },
      });
    }
    clear();
  };

  return { project, record, settle, clear };
}
