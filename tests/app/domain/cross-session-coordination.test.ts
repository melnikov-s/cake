import { describe, expect, it } from "vitest";
import {
  deriveCrossSessionDeliveryStatus,
  encodeCrossSessionMessage,
  parseCrossSessionMessage,
  type CrossSessionMessageMetadata,
} from "../../../src/domain/conversations/cross-session-coordination";
import { projectQueuedMessages } from "../../../src/services/pi/runtime/session-projection";

const metadata: CrossSessionMessageMetadata = {
  version: 1,
  messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
  threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
  sequence: 2,
  maxMessages: 15,
  sender: {
    kind: "project-session",
    sessionId: "source-session",
    title: "Review",
    projectName: "Cake",
    workingDirectory: "/projects/cake",
  },
};

describe("cross-session coordination metadata", () => {
  it.each([
    ["queue", "missing", "unknown", false, "queued"],
    ["prompt", "missing", "unknown", false, "accepted"],
    ["queue", "queued", "unknown", false, "queued"],
    ["prompt", "projected", "unknown", false, "delivered"],
    ["prompt", "projected", "active", false, "processing"],
    ["prompt", "projected", "complete", false, "delivered"],
    ["prompt", "projected", "complete", true, "answered"],
    ["prompt", "projected", "failed", false, "failed"],
    ["prompt", "projected", "aborted", false, "canceled"],
  ] as const)(
    "derives %s delivery with a %s message and %s turn (assistant response: %s) as %s",
    (delivery, messageState, turnState, assistantResponseProjected, expected) => {
      expect(
        deriveCrossSessionDeliveryStatus(delivery, {
          messageState,
          turnState,
          assistantResponseProjected,
        }),
      ).toBe(expected);
    },
  );

  it("round-trips validated sender and thread identity while preserving the message text", () => {
    const encoded = encodeCrossSessionMessage("A session-authored reply", metadata);

    expect(parseCrossSessionMessage(encoded)).toEqual({
      text: "A session-authored reply",
      metadata,
    });
    expect(encoded).toContain("<cake-session-message>");
  });

  it("projects queued messages with a sender label without exposing the envelope as user text", () => {
    const [part] = projectQueuedMessages([], [encodeCrossSessionMessage("Queued reply", metadata)]);

    expect(part).toMatchObject({
      kind: "text",
      role: "user",
      text: "Queued reply",
      deliveryState: "queued",
      crossSession: metadata,
    });
  });

  it("does not reinterpret malformed ordinary Pi transcript content", () => {
    expect(
      parseCrossSessionMessage(
        '<cake-session-message>{"version":1,"sender":"untrusted"}</cake-session-message>\nHello',
      ),
    ).toBeUndefined();
  });
});
