import { describe, expect, it } from "vitest";
import {
  crossSessionContextSnapshot,
  deriveCrossSessionDeliveryStatus,
  encodeCrossSessionMessage,
  parseCrossSessionMessage,
  type CrossSessionMessageMetadata,
} from "../../../src/domain/conversations/cross-session-coordination";
import {
  projectQueuedMessages,
  projectSessionEntries,
} from "../../../src/services/pi/runtime/session-projection";

const metadata: CrossSessionMessageMetadata = {
  version: 1,
  messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
  threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
  sequence: 2,
  expectsResponse: true,
  maxMessages: 15,
  context: { usedTokens: 81_000, windowTokens: 128_000 },
  sender: {
    kind: "project-session",
    sessionId: "source-session",
    title: "Review",
    projectName: "Cake",
    workingDirectory: "/projects/cake",
  },
};

describe("cross-session coordination metadata", () => {
  it("normalizes known and unknown Pi context without zero sentinels", () => {
    expect(crossSessionContextSnapshot(undefined)).toEqual({
      usedTokens: null,
      windowTokens: null,
    });
    expect(crossSessionContextSnapshot({ tokens: null, contextWindow: 128_000 })).toEqual({
      usedTokens: null,
      windowTokens: 128_000,
    });
    expect(crossSessionContextSnapshot({ tokens: 81_000, contextWindow: 128_000 })).toEqual({
      usedTokens: 81_000,
      windowTokens: 128_000,
    });
  });

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

  it("projects queued messages with sender metadata and detected Markdown", () => {
    const [part] = projectQueuedMessages(
      [],
      [encodeCrossSessionMessage("# Queued reply\n\n- First detail", metadata)],
    );

    expect(part).toMatchObject({
      kind: "text",
      role: "user",
      text: "# Queued reply\n\n- First detail",
      deliveryState: "queued",
      renderAs: "markdown",
      crossSession: metadata,
    });
  });

  it("detects Markdown when projecting delivered cross-session messages", () => {
    const [part] = projectSessionEntries([
      {
        type: "message",
        id: "cross-session-message",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: {
          role: "user",
          content: encodeCrossSessionMessage("**Completed** the review", metadata),
          timestamp: 0,
        },
      },
    ] as never);

    expect(part).toMatchObject({
      kind: "text",
      role: "user",
      text: "**Completed** the review",
      renderAs: "markdown",
      crossSession: metadata,
    });
  });

  it("preserves unknown context occupancy without inventing zero usage", () => {
    const unknown = {
      ...metadata,
      context: { usedTokens: null, windowTokens: 128_000 },
    };
    expect(
      parseCrossSessionMessage(encodeCrossSessionMessage("Continue", unknown))?.metadata,
    ).toEqual(unknown);
  });

  it("decodes legacy coordination messages as informational", () => {
    const legacy = `<cake-session-message>${JSON.stringify({
      ...metadata,
      expectsResponse: undefined,
    })}</cake-session-message>\n\nLegacy result`;
    expect(parseCrossSessionMessage(legacy)?.metadata.expectsResponse).toBe(false);
  });

  it("does not reinterpret malformed ordinary Pi transcript content", () => {
    expect(
      parseCrossSessionMessage(
        '<cake-session-message>{"version":1,"sender":"untrusted"}</cake-session-message>\nHello',
      ),
    ).toBeUndefined();
  });
});
