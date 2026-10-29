import assert from "node:assert/strict";
import { ProjectTodoReports } from "../../../src/services/projects/ProjectTodoReports";
import { it } from "@effect/vitest";
import { vi } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { appendMessageReferences } from "../../../src/contracts/conversations/message-reference-forwarding";
import type { Attachment } from "../../../src/contracts/conversations/session-contract";
import type { TaskInputReference } from "../../../src/contracts/conversations/task-input";
import { acquireOptions as chatOptions } from "../../../src/domain/cake-chats/cakeChatRuntime";
import { deliver } from "../../../src/domain/session-families/sessionFamilies";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { Cause, Deferred, Effect, Exit, Layer, Queue, Schema, Stream } from "effect";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { parseCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { SessionFamilyStorageError } from "../../../src/contracts/storage/session-family-storage-errors";
import { SessionSendBatchReceipt } from "../../../src/contracts/conversations/session-send-batch";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { route } from "../../../src/domain/session-families/sessionFamilyMessaging";
import { ProjectSessionError } from "../../../src/contracts/project-sessions/project-session-data";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLayer,
} from "../../../src/services/pi/CakeSessionRuntimes";
import type { PiPendingMessages } from "../../../src/contracts/conversations/pending-message-data";
import {
  SessionCatalogChanges,
  type SessionCatalogChange,
} from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import {
  makeRuntimeRecoveryStorageTestLayer,
  fakeRuntime,
  snapshot,
} from "../helpers/piRuntimeFixture";
import { makeProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";

const location = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  sessionDirectory: "/cake/sessions",
  resolvedSessionDirectory: "/cake/resolved",
};
const familyId = "4c41e44b-df48-4dfb-a891-d77748851586";
const messageId = "0b1bf3dd-458b-4025-8c39-c4f4e2febc0e";
const queueItemId = "3d7377aa-d150-49a7-a685-81a5eb974e73";
const caller = { sessionId: "root", location };
const inputRefId = "088105cf-be48-4b90-84a0-c2ec1cb2da41";
const addFamily = Effect.gen(function* () {
  yield* (yield* SessionFamilyStorage).addChild({
    familyId,
    parentSessionId: "root",
    parentWorkingDirectory: "/project",
    childSessionId: "child",
    childWorkingDirectory: "/project",
    requestId: "create-child",
    projectPath: "/project",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
});

const environment = (
  pi: Layer.Layer<CakeSessionRuntimes>,
  changes: SessionCatalogChange[] = [],
  namespace: "active" | "resolved" = "active",
) =>
  Layer.mergeAll(
    WorkflowTestLive,
    familyStorageHarness().layer,
    makeProjectSessionRuntimeMechanismTestLayer(),
    Layer.mock(SessionCatalogChanges, {
      publish: (change) =>
        Effect.sync(() => {
          changes.push(change);
        }),
    }),
    Layer.mock(ApplicationState, {
      snapshot: () => ({
        ...defaultApplicationState(),
        projects: [
          {
            path: "/project",
            name: "Project",
            addedAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    }),
    Layer.mock(SessionArchiveStorage, {
      locate: () => Effect.succeed(namespace),
      resolvedProjects: () => Stream.empty,
      resolved: () => Stream.empty,
    }),
    Layer.mock(ManagedWorktrees, { records: () => Effect.succeed([]) }),
    pi,
  );

// Consumed-request selection and durable receipt correlation are covered end to
// end in sessionFamilyReplySelection.test.ts. Coordinator routing (including no
// spawning association) is covered in spawnedSessionReporting.test.ts.
it.effect.each([
  { streaming: false, delivery: undefined, expected: "prompt", lane: "prompt", ask: true },
  { streaming: true, delivery: undefined, expected: "steer", lane: "steer", ask: true },
  { streaming: true, delivery: "steer" as const, expected: "steer", lane: "steer", ask: true },
  { streaming: false, delivery: "queue" as const, expected: "queue", lane: "follow-up", ask: true },
  // Omitted resultDelivery retains a quiet completion, never automatic continuation.
  { streaming: true, delivery: "steer" as const, expected: "steer", lane: "steer", ask: false },
])(
  "starts idle corrections, steers active corrections by default, and retains explicit queues (%j)",
  (scenario) =>
    Effect.gen(function* () {
      const received = yield* Queue.unbounded<{ text: string; delivery: string }>();
      const release = yield* Deferred.make<void>();
      const queued = yield* Deferred.make<void>();
      const changes: SessionCatalogChange[] = [];
      let pending: PiPendingMessages = { items: [] };
      const pi = makeCakeSessionRuntimesLayer({
        sessionIds: () => Stream.empty,
        catalog: () => Stream.empty,
        catalogEntry: () => Effect.succeed(undefined),
        inspect: () => Effect.succeed(undefined),
        changelog: () => Effect.succeed(""),
        createRuntime: (options) =>
          Effect.succeed({
            ...fakeRuntime(options, () => undefined),
            sessionId: options.sessionId ?? "unknown",
            streaming: scenario.streaming,
            snapshot: async () => ({
              ...snapshot,
              sessionId: options.sessionId ?? "unknown",
              streaming: scenario.streaming,
            }),
            pendingMessages: async () => {
              await Effect.runPromise(Deferred.await(queued));
              return pending;
            },
            prompt: (text, delivery) => {
              const parsed = parseCrossSessionMessage(text);
              if (delivery === "follow-up" && parsed)
                pending = {
                  items: [
                    {
                      itemId: queueItemId,
                      lane: "follow-up",
                      position: 1,
                      state: "queued",
                      text: parsed.text,
                      crossSession: parsed.metadata,
                    },
                  ],
                };
              Deferred.doneUnsafe(queued, Effect.void);
              return Effect.runPromise(
                Queue.offer(received, { text, delivery }).pipe(
                  Effect.andThen(Deferred.await(release)),
                ),
              );
            },
          }),
      }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
      yield* Effect.gen(function* () {
        yield* addFamily;
        // Exercise the decoder/cancellation adapter as well as the extracted route.
        const options = yield* acquireOptions({ location, sessionId: "root", newSession: false });
        const send = options.runtime.currentSessionControl?.routeFamilyMessage;
        assert.ok(send);
        const receipt = yield* Effect.promise(() =>
          send(
            "sessions.send",
            {
              sessionId: "child",
              text: "Investigate queue behavior",
              ...(scenario.ask ? { resultDelivery: "reply" } : {}),
              ...(scenario.delivery ? { delivery: scenario.delivery } : {}),
            },
            new AbortController().signal,
            { usedTokens: 10, windowTokens: 100 },
          ),
        );
        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            messageId: Schema.String,
            threadId: Schema.String,
            turnId: Schema.String,
            delivery: Schema.String,
            expectsResponse: Schema.Boolean,
            resultDelivery: Schema.Literals(["reply", "notification", "ignore"]),
            status: Schema.String,
            queue: Schema.optionalKey(
              Schema.Struct({
                itemId: Schema.String,
                lane: Schema.String,
                position: Schema.Number,
                length: Schema.Number,
              }),
            ),
          }),
        )(receipt);
        const delivered = yield* Queue.take(received);
        assert.equal(delivered.delivery, scenario.lane);
        assert.equal(decoded.delivery, scenario.expected);
        assert.equal(decoded.expectsResponse, true);
        assert.equal(decoded.resultDelivery, scenario.ask ? "reply" : "notification");
        assert.equal(decoded.status, scenario.expected === "queue" ? "queued" : "accepted");
        const metadata = parseCrossSessionMessage(delivered.text)?.metadata;
        assert.equal(metadata?.messageId, decoded.messageId);
        assert.equal(metadata?.threadId, decoded.threadId);
        assert.equal(metadata?.resultDelivery, decoded.resultDelivery);
        assert.deepEqual(metadata?.context, { usedTokens: 10, windowTokens: 100 });
        const turns = (yield* (yield* SessionFamilyStorage).state()).turns;
        assert.equal(turns.length, 1);
        if (scenario.ask) {
          assert.equal(turns[0]?.turnId, decoded.turnId);
          assert.equal(turns[0]?.requestMessageId, decoded.messageId);
          assert.equal(turns[0]?.reported, false);
        }
        assert.deepEqual(
          decoded.queue,
          scenario.expected === "queue"
            ? {
                itemId: queueItemId,
                lane: "follow-up",
                position: 1,
                length: 1,
              }
            : undefined,
        );
        assert.deepEqual(changes, [
          {
            _tag: "ProjectSessionActivityChanged",
            sessionId: "child",
            projectPath: "/project",
            workingDirectory: "/project",
            sessionDirectory: "/cake/sessions",
          },
          {
            _tag: "ProjectSessionChanged",
            sessionId: "child",
            projectPath: "/project",
            workingDirectory: "/project",
            resolved: false,
          },
        ]);
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.provide(environment(pi, changes)),
      );
    }),
);

it.effect.each([
  { streaming: false, mode: "reference" },
  { streaming: true, mode: "reference" },
  { streaming: false, mode: "question" },
  { streaming: false, mode: "steer" },
  { streaming: false, mode: "blocked" },
  { streaming: false, mode: "substantive" },
])("defers only passive family reference messages (%j)", (scenario) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<string>();
    const pi = makeCakeSessionRuntimesLayer({
      sessionIds: () => Stream.empty,
      catalog: () => Stream.empty,
      catalogEntry: () => Effect.succeed(undefined),
      inspect: () => Effect.succeed(undefined),
      changelog: () => Effect.succeed(""),
      createRuntime: (options) =>
        Effect.succeed({
          ...fakeRuntime(options, () => undefined),
          snapshot: async () => ({
            ...snapshot,
            sessionId: options.sessionId ?? "unknown",
            streaming: scenario.streaming,
          }),
          prompt: async (text) => {
            await Effect.runPromise(Queue.offer(received, text));
          },
        }),
    }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
    yield* Effect.gen(function* () {
      yield* addFamily;
      const text =
        scenario.mode === "substantive"
          ? "Implemented the fix. [Result](cake://session/child?message=entry)"
          : "[Result](cake://session/child?message=entry)";
      const result = yield* route(caller, "sessions.send", {
        sessionId: "child",
        text,
        ...(scenario.mode === "question" ? { resultDelivery: "reply" as const } : null),
        ...(scenario.mode === "steer"
          ? { delivery: "steer" as const }
          : scenario.mode === "reference"
            ? { delivery: "fyi" as const }
            : null),
        ...(scenario.mode === "blocked" ? { outcome: "blocked" as const } : null),
      });
      const state = yield* (yield* SessionFamilyStorage).state();
      if (scenario.mode === "reference") {
        const receipt = yield* Schema.decodeUnknownEffect(SessionSendBatchReceipt)(result);
        assert.equal(receipt.status, "deferred");
        assert.equal(state.passiveNotices?.length, 1);
        assert.ok(state.passiveNotices?.[0]?.text.includes(text));
        assert.equal(yield* Queue.size(received), 0);
      } else {
        assert.equal(state.deferredReferences?.length ?? 0, 0);
        assert.ok((yield* Queue.take(received)).includes(text));
      }
    }).pipe(Effect.provide(environment(pi)));
  }),
);

it.effect.each(
  (["family", "coordinator"] as const).flatMap((destination) =>
    (["completed", "blocked"] as const).flatMap((outcome) =>
      ([undefined, "ignore"] as const).flatMap((resultDelivery) =>
        [
          { payload: "text", messageRefs: [], inputRefs: [] },
          {
            payload: "message references",
            messageRefs: ["cake://session/child?message=evidence"],
            inputRefs: [],
          },
          { payload: "attachments", messageRefs: [], inputRefs: [inputRefId] },
          {
            payload: "references and attachments",
            messageRefs: ["cake://session/child?message=evidence"],
            inputRefs: [inputRefId],
          },
        ].map((payload) => ({ destination, outcome, resultDelivery, ...payload })),
      ),
    ),
  ),
)("preserves explicit terminal report inputs and settles once (%j)", (scenario) =>
  Effect.gen(function* () {
    const targetId = scenario.destination === "family" ? "root" : CAKE_CHAT_SESSION_ID;
    const received: Array<{ text: string; attachments: readonly Attachment[] }> = [];
    const admitted = yield* Queue.unbounded<void>();
    const attachment: TaskInputReference = {
      kind: "input",
      id: inputRefId,
      name: "Evidence",
      mimeType: "text/plain",
      byteLength: 12,
    };
    const authorizeForward = vi.fn<TaskInputStorage["Service"]["authorizeForward"]>(
      (_owner, refs) => Effect.succeed(refs),
    );
    const grant = vi.fn<TaskInputStorage["Service"]["grant"]>(() => Effect.succeed([attachment]));
    const resolvedAttachment: Attachment = {
      kind: "text",
      name: "Evidence",
      text: "Test evidence",
      inputReference: attachment,
    };
    const resolve = vi.fn<TaskInputStorage["Service"]["resolve"]>(() =>
      Effect.succeed([resolvedAttachment]),
    );
    const offer = vi.fn<ProjectTodoReports["Service"]["offer"]>(() => Effect.void);
    const pi = makeCakeSessionRuntimesLayer({
      sessionIds: () => Stream.empty,
      catalog: () => Stream.empty,
      catalogEntry: () => Effect.succeed(undefined),
      inspect: () => Effect.succeed(undefined),
      changelog: () => Effect.succeed(""),
      createRuntime: (options) =>
        Effect.succeed({
          ...fakeRuntime(options, () => undefined),
          sessionId: options.sessionId ?? "unknown",
          executingTurnIds: () => (options.sessionId === "child" ? ["turn"] : []),
          snapshot: async () => ({
            ...snapshot,
            sessionId: options.sessionId ?? "unknown",
            parts: received.flatMap(({ text }) => {
              const parsed = parseCrossSessionMessage(text);
              return parsed
                ? [
                    {
                      id: parsed.metadata.messageId,
                      kind: "text" as const,
                      role: "user" as const,
                      status: "complete" as const,
                      text: parsed.text,
                      crossSession: parsed.metadata,
                    },
                  ]
                : [];
            }),
          }),
          prompt: async (text, _delivery, attachments) => {
            assert.equal(options.sessionId, targetId);
            received.push({ text, attachments });
            await Effect.runPromise(Queue.offer(admitted, undefined));
          },
        }),
    }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
    yield* Effect.gen(function* () {
      if (scenario.destination === "family") yield* addFamily;
      const storage = yield* SessionFamilyStorage;
      const sessions = yield* CakeSessionRuntimes;
      yield* sessions.acquire(
        yield* acquireOptions({ location, sessionId: "child", newSession: false }),
      );
      if (scenario.destination === "coordinator")
        yield* sessions.acquire(
          yield* chatOptions({
            configuration: {
              location: { workingDirectory: "/home", sessionDirectory: "/chat" },
              agentDirectory: "/cake",
            },
            target: { sessionId: targetId, tools: [] },
            newSession: false,
          }),
        );
      yield* storage.recordTurn({
        sessionId: "child",
        senderSessionId: targetId,
        turnId: "turn",
        requestMessageId: messageId,
        threadId: familyId,
        resultDelivery: "reply",
        reported: false,
      });
      const recordReport = vi.fn(storage.recordReport);
      const text =
        scenario.outcome === "completed"
          ? "Fixed the queue race and verified the regression tests."
          : "Blocked: the required credentials are unavailable in this environment.";
      const reportText = appendMessageReferences(text, scenario.messageRefs);
      const result = yield* route({ sessionId: "child", location }, "sessions.reply", {
        text,
        outcome: scenario.outcome,
        resultKind: "ready",
        messageRefs: scenario.messageRefs,
        inputRefs: scenario.inputRefs,
        ...(scenario.resultDelivery ? { resultDelivery: scenario.resultDelivery } : null),
      }).pipe(Effect.provideService(SessionFamilyStorage, { ...storage, recordReport }));
      assert.equal(recordReport.mock.calls.length, 1);
      assert.deepEqual(recordReport.mock.calls[0], [
        "turn",
        {
          outcome: scenario.outcome,
          resultKind: "ready",
          text: reportText,
        },
      ]);
      assert.deepEqual(offer.mock.calls, [[{ sessionId: "child", projectPath: "/project", text }]]);
      const pending = (yield* storage.state()).turns.find((turn) => turn.turnId === "turn");
      assert.ok(pending);
      assert.equal(pending.report?.text, reportText);
      assert.equal(pending.outcome, undefined);
      assert.equal(pending.reported, false);
      if (scenario.inputRefs.length) {
        const receipt = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            ...SessionSendBatchReceipt.fields,
            command: Schema.Literal("sessions.reply"),
          }),
        )(result);
        assert.equal(receipt.status, "accepted");
        assert.equal(receipt.resultDelivery, scenario.resultDelivery ?? "notification");
        assert.equal(receipt.expectsResponse, scenario.resultDelivery !== "ignore");
        yield* Queue.take(admitted);
        assert.equal(received.length, 1);
        assert.deepEqual(received[0]?.attachments, [
          scenario.destination === "family" ? resolvedAttachment : attachment,
        ]);
        const message = parseCrossSessionMessage(received[0]?.text ?? "");
        assert.equal(message?.text, reportText);
        assert.equal(message?.metadata.replyToMessageId, messageId);
        assert.equal(message?.metadata.threadId, familyId);
        assert.deepEqual(pending.replyMessageIds, [message?.metadata.messageId]);
        assert.equal(pending.deliveryTurnId, receipt.turnId);
        assert.deepEqual(authorizeForward.mock.calls, [["child", scenario.inputRefs, targetId]]);
        if (scenario.destination === "family") {
          assert.deepEqual(resolve.mock.calls, [
            [
              targetId,
              [
                {
                  kind: "forwarded-input",
                  name: "Attachment",
                  reference: inputRefId,
                },
              ],
            ],
          ]);
          assert.equal(grant.mock.calls.length, 0);
        } else {
          assert.deepEqual(grant.mock.calls, [[targetId, scenario.inputRefs]]);
          assert.equal(resolve.mock.calls.length, 0);
        }
      } else {
        assert.deepEqual(result, {
          ok: true,
          command: "sessions.reply",
          status: "report-recorded",
          expectsResponse: false,
        });
        assert.equal(received.length, 0);
        assert.equal(pending.deliveryTurnId, undefined);
        assert.equal(authorizeForward.mock.calls.length, 0);
      }
      yield* storage.settleTurn("turn", "complete");
      const settled = (yield* storage.state()).turns.find((turn) => turn.turnId === "turn");
      assert.ok(settled);
      assert.equal(settled.report?.outcome, scenario.outcome);
      assert.equal(settled.report?.text, reportText);
      yield* deliver(settled);
      if (!scenario.inputRefs.length) {
        yield* Queue.take(admitted);
        assert.ok(received[0]?.text.includes(reportText));
        assert.deepEqual(received[0]?.attachments, []);
      }
      // A second worker pass observes the durable transcript receipt, not another send.
      yield* deliver(settled);
      assert.equal(
        (yield* storage.state()).turns.some((turn) => turn.turnId === "turn"),
        false,
      );
      assert.equal(received.length, 1);
      assert.equal(recordReport.mock.calls.length, 1);
      assert.equal(authorizeForward.mock.calls.length, scenario.inputRefs.length ? 1 : 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          environment(pi),
          Layer.mock(TaskInputStorage, {
            isRecipient: () => Effect.succeed(false),
            authorizeForward,
            grant,
            resolve,
          }),
          Layer.mock(ProjectTodoReports, { offer }),
        ),
      ),
    );
  }),
);

it.effect("records a substantive completion report without sending it before settlement", () =>
  Effect.gen(function* () {
    yield* addFamily;
    const storage = yield* SessionFamilyStorage;
    yield* storage.recordTurn({
      sessionId: "child",
      senderSessionId: "root",
      turnId: "turn",
      requestMessageId: messageId,
      threadId: familyId,
      reported: false,
    });
    const result = yield* route({ sessionId: "child", location }, "sessions.reply", {
      text: "Fixed the queue race and verified the regression tests.",
      outcome: "completed",
    });
    assert.deepEqual(result, {
      ok: true,
      command: "sessions.reply",
      status: "report-recorded",
      expectsResponse: false,
    });
    const batches = yield* (yield* ProjectTodoReports)
      .reports()
      .pipe(Stream.take(1), Stream.runCollect);
    assert.deepEqual(
      batches.flat().map(({ text }) => text),
      ["Fixed the queue race and verified the regression tests."],
    );
    const [turn] = (yield* storage.state()).turns;
    assert.ok(turn);
    assert.deepEqual(turn.report, {
      outcome: "completed",
      text: "Fixed the queue race and verified the regression tests.",
    });
    assert.equal(turn.outcome, undefined);
    assert.equal(turn.deliveryTurnId, undefined);
    assert.equal(turn.reported, false);
    const acknowledgment = yield* route({ sessionId: "child", location }, "sessions.reply", {
      text: "Thanks",
      outcome: "completed",
    }).pipe(Effect.flip);
    assert.equal(acknowledgment._tag, "ProjectSessionError");
    assert.match(acknowledgment.message, /substantive/);
  }).pipe(
    Effect.provide(
      Layer.merge(
        environment(
          Layer.mock(CakeSessionRuntimes, { executingTurnIds: () => Effect.succeed(["turn"]) }),
        ),
        ProjectTodoReports.layer,
      ),
    ),
  ),
);

it.effect("rejects delivery to a resolved family without admitting or publishing a message", () => {
  const changes: SessionCatalogChange[] = [];
  return Effect.gen(function* () {
    yield* addFamily;
    const failure = yield* route(caller, "sessions.send", {
      sessionId: "child",
      text: "Continue work",
    }).pipe(Effect.flip);
    assert.ok(failure instanceof ProjectSessionError);
    assert.equal(
      failure.message,
      `Session Family ${familyId} is resolved; restore it explicitly before messaging`,
    );
    assert.deepEqual((yield* (yield* SessionFamilyStorage).state()).turns, []);
    assert.deepEqual(changes, []);
  }).pipe(Effect.provide(environment(Layer.mock(CakeSessionRuntimes, {}), changes, "resolved")));
});

it.effect("retains the not-handled fallback for unrelated destinations and unmatched replies", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* route(caller, "sessions.send", { sessionId: "unrelated", text: "Question" }),
      undefined,
    );
    yield* addFamily;
    assert.equal(
      yield* route(caller, "sessions.send", { sessionId: "unrelated", text: "Question" }),
      undefined,
    );
    assert.equal(
      yield* route(caller, "sessions.reply", { text: "No request is executing" }),
      undefined,
    );
  }).pipe(
    Effect.provide(
      environment(Layer.mock(CakeSessionRuntimes, { executingTurnIds: () => Effect.succeed([]) })),
    ),
  ),
);

it.effect("propagates callback cancellation to routing and runs its finalizers", () =>
  Effect.gen(function* () {
    const storage = yield* SessionFamilyStorage;
    const entered = yield* Deferred.make<void>();
    const finalized = yield* Deferred.make<void>();
    let wait = false;
    const options = yield* acquireOptions({ location, sessionId: "root", newSession: false }).pipe(
      Effect.provideService(SessionFamilyStorage, {
        ...storage,
        familyForMember: (sessionId) =>
          wait
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(finalized, undefined)),
              )
            : storage.familyForMember(sessionId),
      }),
    );
    const send = options.runtime.currentSessionControl?.routeFamilyMessage;
    assert.ok(send);
    wait = true;
    const controller = new AbortController();
    const result = send(
      "sessions.send",
      { sessionId: "child", text: "Question" },
      controller.signal,
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    yield* Deferred.await(entered);
    controller.abort();
    const failure = yield* Effect.promise(() => result);
    yield* Deferred.await(finalized);
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /interrupt/i);
    assert.equal(Schema.is(ProjectSessionError)(failure), false);
  }).pipe(Effect.provide(environment(Layer.mock(CakeSessionRuntimes, {})))),
);

it.effect("maps expected routing failures without converting defects or interruption", () =>
  Effect.gen(function* () {
    const storage = yield* SessionFamilyStorage;
    const expected = new SessionFamilyStorageError({
      operation: "read",
      message: "Family store unavailable",
    });
    const send = route(caller, "sessions.send", { sessionId: "child", text: "Question" });
    const failure = yield* send.pipe(
      Effect.provideService(SessionFamilyStorage, {
        ...storage,
        familyForMember: () => Effect.fail(expected),
      }),
      Effect.flip,
    );
    assert.equal(failure._tag, "ProjectSessionError");
    assert.equal(failure.message, expected.message);
    const defect = yield* send.pipe(
      Effect.provideService(SessionFamilyStorage, {
        ...storage,
        familyForMember: () => Effect.die("routing defect"),
      }),
      Effect.exit,
    );
    assert.ok(Exit.isFailure(defect) && Cause.hasDies(defect.cause));
    const interrupted = yield* send.pipe(
      Effect.provideService(SessionFamilyStorage, {
        ...storage,
        familyForMember: () => Effect.interrupt,
      }),
      Effect.exit,
    );
    assert.ok(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause));
  }).pipe(Effect.provide(environment(Layer.mock(CakeSessionRuntimes, {})))),
);
