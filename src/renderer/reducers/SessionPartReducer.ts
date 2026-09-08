import { type Snapshot } from "r-state-tree";
import type { uiPartSchema } from "../../ipc/session-contract";
import { Message } from "../models/Message";

export function applyPartUpdate(parts: Message[], part: typeof uiPartSchema.Type) {
  const index = parts.findIndex((current) => current.id === part.id);
  const createPart = () => Message.create(messageSnapshots([part])[0]);
  if (index < 0) {
    parts.push(createPart());
    return;
  }
  if (!parts[index]!.update(part)) parts.splice(index, 1, createPart());
}

export function removePart(parts: Message[], partId: string) {
  const index = parts.findIndex((part) => part.id === partId);
  if (index >= 0) parts.splice(index, 1);
}

export function messageSnapshots(
  parts: ReadonlyArray<typeof uiPartSchema.Type>,
): Snapshot<Message>[] {
  // SAFETY: Message's snapshot variants are exactly the validated UiPart union.
  return parts as Snapshot<Message>[];
}
