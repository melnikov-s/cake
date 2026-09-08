import { type Snapshot } from "r-state-tree";
import type { uiPartSchema } from "../../ipc/session-contract";
import { projectionId } from "../../utils/projection-id";
import { Message } from "../models/Message";

export function applyPartUpdate(parts: Message[], part: typeof uiPartSchema.Type, ownerId: string) {
  const index = parts.findIndex((current) => current.partKey === part.id);
  const createPart = () => Message.create(messageSnapshots([part], ownerId)[0]);
  if (index < 0) {
    parts.push(createPart());
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
  return parts.map((part): Snapshot<Message> => {
    const identity = { id: projectionId(ownerId, part.id), partKey: part.id };
    if (part.kind === "text" || part.kind === "skill") {
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
    return { ...part, ...identity };
  });
}
