import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ProjectSessionPromptInput } from "../../../src/domain/project-session-data";
import { applyAnnotationUpdate, createAnnotation } from "../../../src/utils/annotations";

const id = "eeae3d6e-4c89-4e7a-9169-ec21bb8d3b9d";
const requiredFields = {
  messageId: "assistant-1",
  selectedText: "important",
  startOffset: 6,
  endOffset: 15,
  contextBefore: "Alpha ",
  contextAfter: " detail.",
};

describe("annotations", () => {
  it("omits undefined optional fields from prompt attachments", () => {
    const annotation = createAnnotation(id, {
      ...requiredFields,
      entryId: undefined,
      comment: undefined,
    });

    expect(annotation).toEqual({ id, ...requiredFields });
    expect(() =>
      Schema.decodeUnknownSync(ProjectSessionPromptInput)({
        sessionId: "session-1",
        text: "",
        attachments: [{ kind: "annotation", annotations: [annotation] }],
        renderUserMessageAsMarkdown: false,
      }),
    ).not.toThrow();
  });

  it("removes optional fields when an annotation is updated", () => {
    const annotation = createAnnotation(id, {
      ...requiredFields,
      entryId: "entry-1",
      comment: "Remember this",
    });

    expect(applyAnnotationUpdate(annotation, { entryId: undefined, comment: undefined })).toEqual({
      id,
      ...requiredFields,
    });
  });
});
