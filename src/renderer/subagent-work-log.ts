import { z } from "zod";
import type { UiPart } from "../ipc/session-contract";
import { toolOperationName } from "../utils/cake-tool";

type ToolPart = Extract<UiPart, { kind: "tool" }>;

interface SubagentWorkLogItem {
  kind: "subagent-work-log";
  id: string;
  spawn: ToolPart;
  result: ToolPart;
}

export type WorkLogItem = UiPart | SubagentWorkLogItem;

const handleProjectionSchema = z.object({ handleId: z.uuid() }).passthrough();
const gatewayInputSchema = z.object({ input: z.unknown() }).passthrough();

function handleId(value: string | undefined) {
  if (!value) return undefined;
  try {
    const raw: unknown = JSON.parse(value);
    const gateway = gatewayInputSchema.safeParse(raw);
    const parsed = handleProjectionSchema.safeParse(gateway.success ? gateway.data.input : raw);
    return parsed.success ? parsed.data.handleId : undefined;
  } catch {
    return undefined;
  }
}

/** Combines the internal spawn + wait protocol into one user-facing subagent run. */
export function combineSubagentWorkLogParts(parts: UiPart[]): WorkLogItem[] {
  const items: WorkLogItem[] = [];
  const spawns = new Map<string, number>();

  for (const part of parts) {
    if (part.kind === "tool" && toolOperationName(part) === "subagents.spawn") {
      const index = items.push(part) - 1;
      const handle = handleId(part.output);
      if (handle) spawns.set(handle, index);
      continue;
    }
    if (part.kind === "tool" && toolOperationName(part) === "subagents.wait") {
      const handle = handleId(part.input);
      const spawnIndex = handle ? spawns.get(handle) : undefined;
      const spawn = spawnIndex === undefined ? undefined : items[spawnIndex];
      if (spawnIndex !== undefined && spawn?.kind === "tool") {
        items[spawnIndex] = {
          kind: "subagent-work-log",
          id: spawn.id,
          spawn,
          result: part,
        };
        continue;
      }
    }
    items.push(part);
  }

  return items;
}
