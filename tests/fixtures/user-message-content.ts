import type { Annotation, Attachment } from "../../src/contracts/conversations/session-contract";

export const orderingAnnotation: Annotation = {
  id: "00000000-0000-4000-8000-000000000001",
  messageId: "answer",
  entryId: "answer-entry",
  selectedText: "Keep submitted content visibly attributed.",
  startOffset: 0,
  endOffset: 42,
  contextBefore: "",
  contextAfter: "",
  comment: "Put the author before this annotation.",
};

export const orderingFile: Attachment = {
  kind: "input",
  id: "00000000-0000-4000-8000-000000000002",
  name: "notes.txt",
  mimeType: "text/plain",
  byteLength: 42,
};
