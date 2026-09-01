import { Option, Schema } from "effect";
import type { UiPart } from "../ipc/session-contract";
import { toolOperationName } from "../utils/cake-tool";

type ToolPart = Extract<UiPart, { kind: "tool" }>;

interface SubagentWorkLogItem {
  kind: "subagent-work-log";
  id: string;
  handleId: string;
  parts: ToolPart[];
  start?: ToolPart;
  latest: ToolPart;
}

export type WorkLogItem = UiPart | SubagentWorkLogItem;

const handleProjectionSchema = Schema.Struct({
  handleId: Schema.String.check(Schema.isUUID()),
});
const gatewayInputSchema = Schema.Struct({ input: Schema.Unknown });

function handleId(value: string | undefined) {
  if (!value) return undefined;
  try {
    const raw: unknown = JSON.parse(value);
    const gateway = Schema.decodeUnknownOption(gatewayInputSchema)(raw);
    const parsed = Schema.decodeUnknownOption(handleProjectionSchema)(
      Option.isSome(gateway) ? gateway.value.input : raw,
    );
    return Option.isSome(parsed) ? parsed.value.handleId : undefined;
  } catch {
    return undefined;
  }
}

function subagentHandle(part: ToolPart) {
  return handleId(part.output) ?? handleId(part.input);
}

/**
 * Projects every foreground run or background start and its later completion or
 * wait for a stable handle as one work-log item. Background items remain at the
 * start's transcript position while later protocol activity updates them.
 */
export function combineSubagentWorkLogParts(parts: UiPart[]): WorkLogItem[] {
  const items: WorkLogItem[] = [];
  const itemByHandle = new Map<string, number>();

  for (const part of parts) {
    if (part.kind !== "tool") {
      items.push(part);
      continue;
    }
    const operation = toolOperationName(part);
    if (
      operation !== "subagents.run" &&
      operation !== "subagents.start" &&
      operation !== "subagents.wait" &&
      operation !== "subagents.completion"
    ) {
      items.push(part);
      continue;
    }
    const handle = subagentHandle(part);
    if (!handle) {
      items.push(part);
      continue;
    }
    const existingIndex = itemByHandle.get(handle);
    const existing = existingIndex === undefined ? undefined : items[existingIndex];
    if (existingIndex !== undefined && existing?.kind === "subagent-work-log") {
      existing.parts.push(part);
      existing.latest = part;
      if (operation === "subagents.start") existing.start = part;
      continue;
    }
    const index =
      items.push({
        kind: "subagent-work-log",
        id: `subagent-${handle}`,
        handleId: handle,
        parts: [part],
        start: operation === "subagents.start" ? part : undefined,
        latest: part,
      }) - 1;
    itemByHandle.set(handle, index);
  }

  return items;
}
