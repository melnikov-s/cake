import { describe, expect, it } from "vitest";
import { encodeCrossSessionMessage } from "../../../src/domain/conversations/cross-session-coordination";
import type { ScheduledMessage } from "../../../src/domain/scheduled-messages/scheduled-message-data";
import {
  encodeScheduledMessage,
  parseScheduledMessage,
  scheduledMessageOrigin,
  type ScheduledMessageOrigin,
} from "../../../src/domain/scheduled-messages/scheduled-message-envelope";
import {
  locateQueuedMessage,
  projectQueuedMessages,
  projectSessionEntries,
} from "../../../src/services/pi/runtime/session-projection";

const message: ScheduledMessage = {
  id: "8de1a807-dc99-49ee-8d35-7a3ed20bef06",
  targetSessionId: "session-1",
  text: "Check the build",
  sendAt: "2026-09-04T12:02:00.000Z",
  createdAt: "2026-09-04T11:59:00.000Z",
  createdBySessionId: "session-1",
};

const origin: ScheduledMessageOrigin = {
  version: 1,
  id: message.id,
  createdAt: message.createdAt,
  sendAt: message.sendAt,
  createdBySessionId: "session-1",
};

describe("scheduled message envelope", () => {
  it("derives the delivery origin from the stored schedule and round-trips it", () => {
    expect(scheduledMessageOrigin(message)).toEqual(origin);
    expect(
      scheduledMessageOrigin({ ...message, createdBySessionId: undefined }),
    ).not.toHaveProperty("createdBySessionId");

    const encoded = encodeScheduledMessage("Check the build", origin);
    expect(encoded.startsWith("<cake-scheduled-message>")).toBe(true);
    expect(parseScheduledMessage(encoded)).toEqual({ text: "Check the build", origin });
  });

  it("does not reinterpret ordinary or malformed Pi transcript content", () => {
    expect(parseScheduledMessage("Check the build")).toBeUndefined();
    expect(
      parseScheduledMessage(
        '<cake-scheduled-message>{"version":1,"id":"nope"}</cake-scheduled-message>\n\nHello',
      ),
    ).toBeUndefined();
    expect(parseScheduledMessage("<cake-scheduled-message>{not json")).toBeUndefined();
  });

  it("projects a delivered scheduled message as a user turn carrying its origin", () => {
    const parts = projectSessionEntries([
      {
        type: "message",
        id: "user-scheduled",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: {
          role: "user",
          content: encodeScheduledMessage("Check the build", origin),
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "user-typed",
        parentId: "user-scheduled",
        timestamp: new Date(0).toISOString(),
        message: { role: "user", content: "Check the build", timestamp: 0 },
      },
    ] as never);

    expect(parts).toEqual([
      expect.objectContaining({
        kind: "text",
        role: "user",
        entryId: "user-scheduled",
        text: "Check the build",
        scheduled: origin,
      }),
      expect.objectContaining({ kind: "text", role: "user", entryId: "user-typed" }),
    ]);
    expect(parts[0]).toHaveProperty("crossSession", undefined);
    expect(parts[1]).toHaveProperty("scheduled", undefined);
  });

  it("projects queued scheduled and cross-session messages with distinct provenance", () => {
    const crossSession = encodeCrossSessionMessage("Queued reply", {
      version: 1,
      messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
      threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
      sequence: 1,
      sender: { kind: "project-session", sessionId: "source-session", title: "Review" },
    });
    const scheduled = encodeScheduledMessage("Check the build", origin);

    const parts = projectQueuedMessages([], [crossSession, scheduled, "Typed follow-up"]);

    expect(parts.map((part) => (part.kind === "text" ? part.text : part.kind))).toEqual([
      "Queued reply",
      "Check the build",
      "Typed follow-up",
    ]);
    expect(parts[0]).toMatchObject({ deliveryState: "queued", crossSession: expect.anything() });
    expect(parts[0]).not.toHaveProperty("scheduled", expect.anything());
    expect(parts[1]).toMatchObject({ deliveryState: "queued", scheduled: origin });
    expect(parts[1]).not.toHaveProperty("crossSession", expect.anything());
  });

  it("locates projected queued part ids back to their raw queue positions", () => {
    const steering = ["Change direction"];
    const followUp = ["Do this next", "", "Do this next"];
    const pending = ["After compaction"];
    const parts = projectQueuedMessages(steering, followUp, pending);

    expect(parts.map((part) => locateQueuedMessage(part.id, steering, followUp, pending))).toEqual([
      { list: "steering", index: 0 },
      { list: "followUp", index: 0 },
      { list: "followUp", index: 2 },
      { list: "pending", index: 0 },
    ]);
    expect(locateQueuedMessage("missing", steering, followUp, pending)).toBeUndefined();
  });
});
