import type { Annotation } from "../ipc/session-contract";

/** Builds an annotation without explicit `undefined` values at RPC and persistence boundaries. */
export function createAnnotation(id: string, input: Omit<Annotation, "id">): Annotation {
  const annotation: Annotation = {
    id,
    messageId: input.messageId,
    selectedText: input.selectedText,
    startOffset: input.startOffset,
    endOffset: input.endOffset,
    contextBefore: input.contextBefore,
    contextAfter: input.contextAfter,
  };
  if (input.entryId !== undefined) Object.assign(annotation, { entryId: input.entryId });
  if (input.comment !== undefined) Object.assign(annotation, { comment: input.comment });
  return annotation;
}

export function applyAnnotationUpdate(
  annotation: Annotation,
  update: Partial<Omit<Annotation, "id">>,
): Annotation {
  return createAnnotation(annotation.id, { ...annotation, ...update });
}
