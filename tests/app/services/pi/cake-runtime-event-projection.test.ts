import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createCakeRuntimeEventProjection,
  type RuntimeProjectionEvent,
} from "../../../../src/services/pi/runtime/cake-runtime-event-projection";
import { projectQueuedMessages } from "../../../../src/services/pi/runtime/session-projection";

describe("Cake runtime queued-part projection", () => {
  it("emits only the queued parts that changed", () => {
    let steering: string[] = [];
    let followUp = ["First", "Remove me", "Last"];
    const events: RuntimeProjectionEvent[] = [];
    // @ts-expect-error -- SAFETY: this focused test invokes only the two queue accessors supplied.
    const session = {
      getSteeringMessages: () => steering,
      getFollowUpMessages: () => followUp,
    } as AgentSession;
    const projection = createCakeRuntimeEventProjection({
      session,
      sessionId: "session-1",
      emit: (event) => events.push(event),
      compactionQueuedMessages: () => [],
      isDisposed: () => false,
    });

    const removedId = projectQueuedMessages([], followUp)[1]!.id;
    followUp = ["First", "Last"];
    projection.syncQueuedParts();

    expect(events).toEqual([{ type: "part-removed", sessionId: "session-1", partId: removedId }]);

    events.length = 0;
    followUp = ["First", "Last", "New"];
    projection.syncQueuedParts();

    expect(events).toEqual([
      {
        type: "part-updated",
        sessionId: "session-1",
        part: projectQueuedMessages([], ["New"])[0],
      },
    ]);

    events.length = 0;
    projection.syncQueuedParts();
    expect(events).toEqual([]);

    events.length = 0;
    steering = ["First"];
    followUp = ["Last", "New"];
    projection.syncQueuedParts();

    const previousFirstId = projectQueuedMessages([], ["First"])[0]!.id;
    expect(events).toEqual([
      { type: "part-removed", sessionId: "session-1", partId: previousFirstId },
      {
        type: "part-updated",
        sessionId: "session-1",
        part: projectQueuedMessages(["First"], [])[0],
      },
    ]);

    projection.dispose();
  });
});
