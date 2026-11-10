import { it } from "@effect/vitest";
import { Context, Effect, Layer, Queue, Stream } from "effect";
import { expect, vi } from "vitest";
import { observe } from "../../../src/domain/conversations/conversations";
import { pendingIncomingParts } from "../../../src/domain/conversations/pendingIncoming";
import type { CakeSessionHandle } from "../../../src/services/pi/CakeSessionRuntimes";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import type { ConversationUpdate } from "../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { SessionFamilyDocument } from "../../../src/contracts/session-families/session-family-document";
import { encodeCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { snapshot } from "../helpers/piRuntimeFixture";

const metadata = (id: string) => ({
  version: 1 as const,
  messageId:
    id === "notice"
      ? "10000000-0000-4000-8000-000000000001"
      : "10000000-0000-4000-8000-000000000002",
  threadId: "20000000-0000-4000-8000-000000000001",
  sequence: 1,
  expectsResponse: false,
  sender: { sessionId: "sender", title: "Sender", kind: "project-session" as const },
});
const notice = {
  id: "notice",
  recipientSessionId: "session-1",
  text: "Passive progress",
  crossSession: metadata("notice"),
};
const report = {
  id: "report",
  recipientSessionId: "session-1",
  text: "Worker result",
  source: {
    kind: "subagent" as const,
    handleId: "30000000-0000-4000-8000-000000000001",
    sessionId: "private-worker",
    task: "Investigate",
    status: "completed",
    messageId: "result",
  },
};
const digest = {
  id: "digest",
  coordinatorSessionId: "session-1",
  sessionId: "child",
  title: "Child task",
  status: "completed" as const,
  summary: "Ready for review",
  reportedAt: "2026-01-01",
};

it.effect(
  "previews all actual inbox paths, without treating citations, aliases, held/private reports or other recipients as new incoming messages",
  () =>
    Effect.sync(() => {
      const document: SessionFamilyDocument = {
        families: [],
        turns: [],
        spawnedSessions: [],
        passiveNotices: [
          notice,
          { ...notice, id: "other", recipientSessionId: "other" },
          { ...notice, id: "delivered", delivered: true },
        ],
        coordinatorDigest: [digest],
        deferredReferences: [
          report,
          { ...report, id: "alias" },
          {
            ...report,
            id: "held",
            attentionTodoId: "todo",
            source: { ...report.source, messageId: "held" },
          },
          {
            id: "session-report",
            recipientSessionId: "session-1",
            text: encodeCrossSessionMessage(
              "[Full agent response](cake://session/sender?message=original)",
              metadata("session-report"),
            ),
          },
        ],
      };
      const parts = pendingIncomingParts(document, "session-1");
      expect(parts.map((part) => part.id)).toEqual([
        "session-digest-digest",
        "agent-update-report",
        "passive-session-report",
        "passive-notice",
      ]);
      expect(parts.every((part) => part.pendingIncoming)).toBe(true);
      expect(
        pendingIncomingParts(
          {
            ...document,
            deferredReferences: [
              { ...report, admissions: 1 },
              { ...report, id: "alias" },
            ],
          },
          "session-1",
        ).some((part) => part.id.startsWith("agent-update")),
      ).toBe(false);
      expect(document.deferredReferences?.[0]).not.toHaveProperty("admissions");
    }),
);

for (const streaming of [false, true])
  it.effect(
    `publishes arrival while ${streaming ? "running" : "idle"}, promotes from Pi receipts without waking/acknowledging, and reconnects`,
    () =>
      Effect.gen(function* () {
        const family = familyStorageHarness();
        const core = yield* Layer.build(family.layer);
        const storage = Context.get(core, SessionFamilyStorage);
        let parts: UiPart[] = [];
        const wake = vi.fn();
        const current = () => ({ ...snapshot, streaming, parts });
        // This observation fixture deliberately exposes only read capabilities. Any attempted
        // admission/agent wake is a test failure, not a background fake response.
        const handle = {
          profile: "ProjectSession",
          updates: Stream.succeed({ _tag: "Snapshot", snapshot: current() }).pipe(
            Stream.concat(Stream.never),
          ),
          snapshot: () => Effect.succeed(current()),
          submit: wake,
          prompt: wake,
          followUp: wake,
          steer: wake,
        } as unknown as CakeSessionHandle;
        const events = yield* Queue.unbounded<ConversationUpdate>();
        yield* observe(handle).pipe(
          Stream.runForEach((update) => Queue.offer(events, update)),
          Effect.provide(core),
          Effect.forkScoped,
        );
        const incoming = Effect.gen(function* () {
          while (true) {
            const update = yield* Queue.take(events);
            if (update._tag === "Event" && update.event._tag === "IncomingUpdated")
              return update.event.parts as UiPart[];
          }
        });
        expect(yield* incoming).toEqual([]);
        yield* storage.deferPassiveNotice(notice);
        const preview = yield* incoming;
        expect(preview).toMatchObject([
          { id: "passive-notice", text: "Passive progress", pendingIncoming: true },
        ]);
        expect(yield* storage.state()).toMatchObject({
          passiveNotices: [{ text: "Passive progress" }],
        });
        expect(wake).not.toHaveBeenCalled();
        // A separate storage/runtime observation, as after restart, reconstructs the preview.
        const restarted = yield* Layer.build(familyStorageHarness(family.files).layer);
        const reconnect = yield* observe(handle).pipe(
          Stream.filter(
            (update) => update._tag === "Event" && update.event._tag === "IncomingUpdated",
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.provide(restarted),
        );
        expect(reconnect).toMatchObject([
          { event: { parts: [{ id: "passive-notice", pendingIncoming: true }] } },
        ]);
        // Simulate the already-accepted next human input: Pi owns the normal entry, even if
        // its ordinary event is still in flight to the renderer when the inbox invalidates.
        parts = preview.map(({ pendingIncoming: _, ...part }) => part);
        yield* storage.markPassiveNoticeAdmission([notice.id], "human-turn", true);
        expect(yield* incoming).toEqual(parts);
        expect(wake).not.toHaveBeenCalled();
        expect((yield* storage.state()).handledReports ?? []).toEqual([]);
        yield* storage.deferReferenceNotice(report);
        expect(yield* incoming).toEqual([
          ...parts,
          ...pendingIncomingParts(yield* storage.state(), "session-1"),
        ]);
        yield* storage.recordTurn({
          sessionId: "child",
          senderSessionId: "session-1",
          turnId: "digest",
          requestMessageId: "digest",
          threadId: "digest",
          reported: false,
          outcome: "complete",
          resultDelivery: "notification",
        });
        yield* storage.digestNotice("digest", digest);
        const withDigest = yield* incoming;
        expect(withDigest.filter((part) => part.pendingIncoming).map((part) => part.id)).toEqual([
          "session-digest-digest",
          "agent-update-report",
        ]);
        parts = withDigest.map(({ pendingIncoming: _, ...part }) => part);
        yield* storage.markReferenceAdmissions(["report"]);
        expect(
          (yield* incoming).find((part) => part.id === "agent-update-report")?.pendingIncoming,
        ).toBeUndefined();
        yield* storage.removeDigest(["digest"]);
        expect(yield* incoming).toEqual(parts);
        expect((yield* storage.state()).deferredReferences).toMatchObject([
          { id: "report", admissions: 1 },
        ]);
        expect((yield* storage.state()).handledReports ?? []).toEqual([]);
        expect(wake).not.toHaveBeenCalled();
      }),
  );
