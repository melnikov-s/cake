import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";
import type { AgentActionNotice } from "../../../src/contracts/application/agent-action-notice";
import * as agentActionNotices from "../../../src/domain/application/agentActionNotices";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";

const caller: AgentActionNotice["source"] = {
  kind: "project-session",
  sessionId: "session-caller",
  title: "Caller",
};

/** Present one control result and return the toasts it produced. */
const present = (result: Parameters<typeof agentActionNotices.present>[0]) =>
  Effect.gen(function* () {
    const notices: AgentActionNotice[] = [];
    yield* agentActionNotices.present(result, caller).pipe(
      Effect.provide(
        Layer.mock(RendererRequestCoordinator, {
          presentAgentAction: (notice) => Effect.sync(() => notices.push(notice)),
        }),
      ),
    );
    return notices;
  });

describe("agent action notices for scheduled messages", () => {
  it.effect("stay silent when a session schedules a message to itself", () =>
    Effect.gen(function* () {
      expect(
        yield* present({
          ok: true,
          command: "sessions.schedule",
          target: { sessionId: caller.sessionId },
          targetTitle: "Caller",
          status: "scheduled",
        }),
      ).toEqual([]);
    }),
  );

  it.effect("announce a schedule another session placed on a different target", () =>
    Effect.gen(function* () {
      expect(
        yield* present({
          ok: true,
          command: "sessions.schedule",
          target: { sessionId: "session-other" },
          targetTitle: "Other",
          status: "scheduled",
        }),
      ).toEqual([
        {
          source: caller,
          message: "Scheduled a message for “Other”",
          targetSessionId: "session-other",
          targetKind: "project-session",
          coalesceKey: "schedule:session-other",
        },
      ]);
    }),
  );

  it.effect("stay silent when a session cancels its own scheduled message", () =>
    Effect.gen(function* () {
      expect(
        yield* present({
          ok: true,
          command: "sessions.cancel-scheduled",
          id: "schedule-1",
          target: { sessionId: caller.sessionId },
          status: "cancelled",
        }),
      ).toEqual([]);
    }),
  );

  it.effect("announce cancelling a scheduled message for a different target", () =>
    Effect.gen(function* () {
      expect(
        yield* present({
          ok: true,
          command: "sessions.cancel-scheduled",
          id: "schedule-1",
          target: { sessionId: "session-other" },
          status: "cancelled",
        }),
      ).toEqual([
        {
          source: caller,
          message: "Cancelled a scheduled message",
          coalesceKey: "cancel:schedule-1",
        },
      ]);
    }),
  );
});
