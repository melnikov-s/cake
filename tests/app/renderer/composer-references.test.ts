import { describe, expect, it } from "vitest";
import {
  sessionLink,
  messageReference,
  attachmentLink,
} from "../../../src/contracts/conversations/message-reference";
import { serializeModelReference } from "../../../src/contracts/model-presets/model-reference";
import { splitComposerReferences } from "../../../src/renderer/lib/composer-references";

describe("composer reference presentation", () => {
  it("preserves canonical IDs, exact tokens and offsets across mixed and repeated references", () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const model = serializeModelReference({
      provider: "fixture",
      modelId: "model",
      thinkingLevel: "off",
      fastMode: false,
    });
    const text = `Use [Session](${sessionLink(sessionId)}) and ${model}, then [Session](${sessionLink("session with spaces")}) and [Session](${sessionLink(sessionId)}).`;
    const segments = splitComposerReferences(text);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
    for (const segment of segments)
      expect(text.slice(segment.start, segment.end)).toBe(segment.text);
    expect(
      segments.filter((segment) => segment.sessionId).map((segment) => segment.sessionId),
    ).toEqual([sessionId, "session with spaces", sessionId]);
    expect(segments.filter((segment) => segment.model)).toHaveLength(1);
  });

  it("leaves exact-message, attachment, invalid and ordinary links literal", () => {
    const text = `[Message](${messageReference("session", "entry")}) [Attachment](${attachmentLink("session", "file")}) [Bad](cake://session/%2F) [Other](https://example.com) [Bad](cake://session/id?unknown=value)`;
    expect(splitComposerReferences(text)).toEqual([{ text, start: 0, end: text.length }]);
  });
});
