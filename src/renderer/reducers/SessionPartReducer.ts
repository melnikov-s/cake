import { type Snapshot } from "r-state-tree";
import type { uiPartSchema } from "../../contracts/conversations/session-contract";
import { projectionId } from "../../utils/projection-id";
import {
  isSystemPromptBaseline,
  systemPromptBaselineFirst,
} from "../../utils/system-prompt-baseline";
import { Message } from "../models/Message";

export function applyPartUpdate(parts: Message[], part: typeof uiPartSchema.Type, ownerId: string) {
  const index = parts.findIndex((current) => current.partKey === part.id);
  const createPart = () => Message.create(messageSnapshots([part], ownerId)[0]);
  if (index < 0) {
    const firstChronological = isSystemPromptBaseline(part)
      ? parts.findIndex((current) => !isSystemPromptBaseline(current.value))
      : -1;
    parts.splice(firstChronological < 0 ? parts.length : firstChronological, 0, createPart());
    return;
  }
  if (!parts[index]!.update(part)) parts.splice(index, 1, createPart());
}

export function removePart(parts: Message[], partId: string) {
  const index = parts.findIndex((part) => part.partKey === partId);
  if (index >= 0) parts.splice(index, 1);
}

export function messageSnapshots(
  parts: ReadonlyArray<typeof uiPartSchema.Type>,
  ownerId: string,
): Snapshot<Message>[] {
  return systemPromptBaselineFirst(parts).map((part): Snapshot<Message> => {
    const identity = { id: projectionId(ownerId, part.id), partKey: part.id };
    if (part.kind === "text") {
      const { entryId, subagentReport, ...fields } = part;
      return {
        ...fields,
        ...identity,
        piId: entryId,
        // Reused Models need an explicit reset when JSON omits presentation metadata.
        renderAs: part.renderAs,
        requestedAt: part.requestedAt,
        taskTodoId: part.taskTodoId,
        taskAttributionPending: part.taskAttributionPending,
        // SAFETY: runtime-validated JSON; Snapshot distributes heterogeneous
        // JSON arrays into homogeneous arrays, but its codec preserves them.
        subagentReport: subagentReport as Snapshot<Message>["subagentReport"],
      };
    }
    if (part.kind === "skill") {
      const { entryId, ...fields } = part;
      return { ...fields, ...identity, piId: entryId };
    }
    if (part.kind === "compaction") {
      const { firstKeptEntryId, ...fields } = part;
      return { ...fields, ...identity, firstKeptPiId: firstKeptEntryId };
    }
    if (part.kind === "annotation")
      return { ...part, ...identity, annotations: [...part.annotations] };
    if (part.kind === "review-run") return { ...part, ...identity, threadIds: [...part.threadIds] };
    if (part.kind === "tool")
      // SAFETY: the transport schema validates this plain JSON projection.
      // r-state-tree's Snapshot type distributes heterogeneous JSON/enum
      // arrays into homogeneous arrays; its snapshot codec preserves them.
      return {
        ...part,
        ...identity,
        interview: part.interview as Snapshot<Message>["interview"],
        interviewResult: part.interviewResult as Snapshot<Message>["interviewResult"],
      };
    return { ...part, ...identity };
  });
}
