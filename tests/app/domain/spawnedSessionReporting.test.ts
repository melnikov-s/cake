import assert from "node:assert/strict";
import { durableAnswer } from "../../fixtures/durable-chat";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Schema, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vitest";
import * as boards from "../../../src/domain/artifacts/messageBoards";
import * as workboardContinuations from "../../../src/domain/session-families/workboardContinuations";
import * as completionInbox from "../../../src/domain/conversations/completionInbox";
import * as families from "../../../src/domain/session-families/sessionFamilies";
import { acquireOptions as projectOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { acquireOptions as chatOptions } from "../../../src/domain/cake-chats/cakeChatRuntime";
import { createPrompted } from "../../../src/domain/project-sessions/projectSessionCreation";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import {
  CAKE_CHAT_SESSION_ID,
  isCakeChatSessionId,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { ResultDelivery } from "../../../src/contracts/conversations/result-delivery";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import type { Attachment } from "../../../src/contracts/conversations/session-contract";
import type { PiTurnResult } from "../../../src/contracts/pi/turn-result-data";
import {
  encodeCrossSessionMessage,
  parseCrossSessionMessage,
} from "../../../src/contracts/conversations/cross-session-message";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLayer,
  PiSessionError,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { PiModels } from "../../../src/services/pi/PiModels";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";
import { messageBoardHarness } from "../helpers/messageBoardHarness";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import type { SessionInspectionQuery } from "../../../src/contracts/conversations/session-query-data";
import {
  makeRuntimeRecoveryStorageTestLayer,
  fakeRuntime,
  snapshot,
} from "../helpers/piRuntimeFixture";
import { projectSessionEntries } from "../../../src/services/pi/runtime/session-projection";
import { TurnCanceledError } from "../../../src/services/pi/runtime/RuntimeTurnCompletion";
import * as pendingReports from "../../../src/domain/conversations/pendingReports";
import * as sessionChats from "../../../src/domain/conversations/sessionChats";
import { splitSessionDigestReminder } from "../../../src/contracts/cake-chats/session-digest-reminder";
import { messageReference } from "../../../src/contracts/conversations/message-reference";
import { splitContextReminders } from "../../../src/services/pi/runtime/session-context-reminders";
import {
  CAKE_CHAT_COMPOSING_HOLD_MS,
  CakeChatComposerPresence,
} from "../../../src/services/session-catalogs/CakeChatComposerPresence";

const location = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  sessionDirectory: "/cake/sessions",
  resolvedSessionDirectory: "/cake/resolved",
};
const configuration = {
  provider: "p",
  modelId: "m",
  thinkingLevel: "off" as const,
  fastMode: false,
};
const parentId = "564295e6-385d-4d74-87b1-88705e101f9c";
const resultText =
  "Research complete: use the existing semantic tokens and shared components. No files changed.";
const createArgs = {
  name: "Research",
  initialPrompt: "Research the design system.",
  model: configuration,
};

const fixture = Effect.fn("SpawnedReportingTest.fixture")(function* (
  busy = false,
  failStartup = false,
) {
  const entered = yield* Deferred.make<{ sessionId: string; turnId: string; text: string }>();
  const finish = yield* Deferred.make<PiTurnResult>();
  const settled = yield* Deferred.make<void>();
  const settledTurns = yield* Queue.unbounded<string>();
  const received = yield* Deferred.make<void>();
  const persisted = yield* Deferred.make<void>();
  const executing = new Map<string, string[]>();
  const consumedInputs = new Set<string>();
  const materialized = new Set<string>([parentId, CAKE_CHAT_SESSION_ID]);
  const consumeQueued = yield* Deferred.make<void>();
  const transcript: string[] = [];
  const assistantReplies: { afterInput: number; text: string }[] = [];
  const chatTranscripts = new Map<string, string[]>([[CAKE_CHAT_SESSION_ID, transcript]]);
  const recipients: string[] = [];
  const deliveries: string[] = [];
  const submittedAttachments = new Map<string, readonly Attachment[]>();
  const queue: string[] = [];
  let beforeRemove = async () => {};
  const queued = new Map<
    string,
    { text: string; steering: boolean; canceled: Deferred.Deferred<void, TurnCanceledError> }
  >();
  const listQueue = () => ({
    steering: [...queued.values()].filter((item) => item.steering).map((item) => item.text),
    followUp: [...queued.values()].filter((item) => !item.steering).map((item) => item.text),
  });
  const removeQueued = (id: string) => {
    const item = queued.get(id);
    if (!item) throw new Error("That message was already consumed");
    queued.delete(id);
    queue.splice(queue.indexOf(item.text), 1);
    Effect.runSync(Deferred.fail(item.canceled, new TurnCanceledError()));
  };
  const harness = familyStorageHarness();
  const environment = Layer.mergeAll(
    WorkflowTestLive,
    makeHeadlessProjectSessionRuntimeMechanismTestLayer(),
    messageBoardHarness().layer,
    harness.layer,
    Layer.mock(ApplicationState, {
      snapshot: () => ({
        ...defaultApplicationState(),
        trustedProjectPaths: ["/project"],
        projects: [
          { path: "/project", name: "Project", addedAt: "2026-01-01", lastOpenedAt: "2026-01-01" },
        ],
      }),
    }),
    Layer.mock(ManagedWorktrees, {
      records: () => Effect.succeed([]),
      awaitSetup: () => Effect.void,
    }),
    Layer.mock(PiModels, { resolve: (selection) => Effect.succeed(selection) }),
    Layer.mock(SessionArchiveStorage, {
      resolvedProjectEntry: () => Effect.succeed(undefined),
      locate: (id) => Effect.succeed(materialized.has(id) ? ("active" as const) : undefined),
      resolved: () => Stream.empty,
      resolvedProjects: () => Stream.empty,
    }),
    SessionCatalogChanges.layer,
    Layer.mock(RendererRequestCoordinator, {
      releaseSession: () => Effect.void,
      requestCakeChatControl: () =>
        Effect.die("Creation and reports must not depend on a renderer lookup"),
    }),
    makeCakeSessionRuntimesLayer({
      sessionIds: () => Stream.empty,
      catalog: () => Stream.empty,
      catalogEntry: () => Effect.succeed(undefined),
      inspect: () => Effect.succeed(undefined),
      changelog: () => Effect.succeed(""),
      createRuntime: (options) =>
        failStartup && options.sessionId !== CAKE_CHAT_SESSION_ID && options.sessionId !== parentId
          ? Effect.fail(new Error("Provider unavailable during session startup"))
          : Effect.sync(() => {
              materialized.add(options.sessionId ?? "unexpected");
              const ownTranscript = isCakeChatSessionId(options.sessionId ?? "")
                ? (chatTranscripts.get(options.sessionId!) ?? [])
                : transcript;
              if (isCakeChatSessionId(options.sessionId ?? ""))
                chatTranscripts.set(options.sessionId!, ownTranscript);
              return {
                ...fakeRuntime(options, () => undefined),
                sessionId: options.sessionId ?? "unexpected",
                sessionFile: `${options.sessionDir}/${options.sessionId}.jsonl`,
                executingTurnIds: () => executing.get(options.sessionId ?? "") ?? [],
                hasConsumedInput: (turnId) => consumedInputs.has(turnId),
                snapshot: async () => ({
                  ...snapshot,
                  sessionId: options.sessionId ?? "unexpected",
                  streaming: busy,
                  parts: projectSessionEntries(
                    ownTranscript.flatMap((content, index) => [
                      {
                        type: "message" as const,
                        id: String(index),
                        parentId: null,
                        timestamp: "2026-01-01T00:00:00.000Z",
                        message: { role: "user" as const, content, timestamp: index },
                      },
                      ...assistantReplies
                        .filter((reply) => reply.afterInput === index)
                        .map((reply, replyIndex) => ({
                          type: "message" as const,
                          id: `reply-${index}-${replyIndex}`,
                          parentId: null,
                          timestamp: "2026-01-01T00:00:00.000Z",
                          message: { ...durableAnswer(reply.text), timestamp: index },
                        })),
                    ]),
                  ),
                }),
                inspectSession: async (query: SessionInspectionQuery) => ({
                  kind: query.kind,
                  sessionId: options.sessionId ?? "unexpected",
                }),
                listQueuedMessages: async () => listQueue(),
                pendingMessages: async () => ({
                  items: [...queued].map(([id, item], index) => ({
                    itemId: id,
                    partId: id,
                    lane: item.steering ? ("steering" as const) : ("follow-up" as const),
                    position: index + 1,
                    state: "queued" as const,
                    text: item.text,
                    crossSession: parseCrossSessionMessage(item.text)?.metadata,
                  })),
                }),
                removeQueuedMessage: async (partId) => {
                  await beforeRemove();
                  removeQueued(partId);
                  return listQueue();
                },
                clearQueue: async () => {
                  for (const id of queued.keys()) removeQueued(id);
                  return listQueue();
                },
                cancelSteering: async () => {
                  for (const [id, item] of queued) if (item.steering) removeQueued(id);
                  return listQueue();
                },
                steerQueuedMessage: async (partId) => {
                  const item = queued.get(partId);
                  assert.ok(item);
                  item.steering = true;
                  return listQueue();
                },
                prompt: (text, delivery, _attachments, _markdown, turnId) =>
                  Effect.runPromise(
                    Effect.gen(function* () {
                      assert.ok(turnId);
                      if (
                        isCakeChatSessionId(options.sessionId ?? "") ||
                        options.sessionId === parentId
                      ) {
                        deliveries.push(delivery);
                        recipients.push(options.sessionId!);
                        if (delivery === "follow-up") {
                          queue.push(text);
                          const canceled = yield* Deferred.make<void, TurnCanceledError>();
                          queued.set(turnId, { text, steering: false, canceled });
                          yield* Deferred.succeed(received, undefined);
                          yield* Effect.raceFirst(
                            Deferred.await(consumeQueued),
                            Deferred.await(canceled),
                          );
                          queued.delete(turnId);
                          queue.splice(queue.indexOf(text), 1);
                        }
                        ownTranscript.push(text);
                        consumedInputs.add(turnId);
                        yield* Deferred.succeed(persisted, undefined);
                        yield* Deferred.succeed(received, undefined);
                      } else {
                        // Pi persists the accepted input before the run finishes.
                        options.onInitialTranscriptPersisted?.();
                        submittedAttachments.set(options.sessionId ?? "", _attachments);
                        executing.set(options.sessionId ?? "", [turnId]);
                        yield* Deferred.succeed(entered, {
                          sessionId: options.sessionId ?? "unexpected",
                          turnId,
                          text,
                        });
                        const result = yield* Deferred.await(finish);
                        // Like the runtime capture: the final answer addresses this input's sender
                        // unless a test says a later input (e.g. the local user) was answered.
                        const sender = parseCrossSessionMessage(text)?.metadata.sender.sessionId;
                        options.onTurnResult?.(
                          turnId,
                          "respondsToSessionId" in result || !sender
                            ? result
                            : { ...result, respondsToSessionId: sender },
                        );
                        executing.delete(options.sessionId ?? "");
                      }
                    }),
                  ),
              };
            }),
    }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer())),
  );
  const context = yield* Layer.build(environment);
  const storage = yield* SessionFamilyStorage.pipe(Effect.provide(context));
  const observedStorage = {
    ...storage,
    settleTurn: (...args: Parameters<typeof storage.settleTurn>) =>
      storage
        .settleTurn(...args)
        .pipe(
          Effect.andThen(Deferred.succeed(settled, undefined)),
          Effect.andThen(Queue.offer(settledTurns, args[0])),
        ),
  };
  return {
    context,
    storage: observedStorage,
    harness,
    entered,
    finish,
    settled,
    settledTurns,
    received,
    persisted,
    consumeQueued,
    queue,
    transcript,
    chatTranscripts,
    reply: (text: string) => {
      assistantReplies.push({ afterInput: transcript.length - 1, text });
    },
    recipients,
    deliveries,
    submittedAttachments,
    beforeRemove: (callback: () => Promise<void>) => {
      beforeRemove = callback;
    },
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(SessionFamilyStorage, observedStorage),
        Effect.provide(context),
      ),
  };
});

const assembleCoordinator = Effect.fn("SpawnedReportingTest.assembleCoordinator")(function* (
  sessionId = CAKE_CHAT_SESSION_ID,
) {
  const sessions = yield* CakeSessionRuntimes;
  const options = yield* chatOptions({
    configuration: {
      location: {
        workingDirectory: sessionId === CAKE_CHAT_SESSION_ID ? "/home" : "/project",
        sessionDirectory: sessionId === CAKE_CHAT_SESSION_ID ? "/chat" : "/project-chat",
      },
      agentDirectory: "/cake",
    },
    target: { sessionId, tools: [] },
    newSession: false,
  });
  yield* sessions.acquire(options);
  return options;
});

/** Existing delivery-mechanics tests opt into immediate reports; digest has its own suite. */
const createFromChat = Effect.fn("SpawnedReportingTest.createFromChat")(function* (
  inputRefs: readonly string[] = [],
  /** null omits the field to exercise Cake Chat's default. */
  resultDelivery: ResultDelivery | null = "reply",

  coordinator = CAKE_CHAT_SESSION_ID,
) {
  const options = yield* assembleCoordinator(coordinator);
  assert.ok(options.runtime.globalControl);
  const result = yield* Effect.promise(() =>
    options.runtime.globalControl!.invoke(
      {
        name: "sessions.create",
        arguments: {
          workspacePath: "/project",
          ...createArgs,
          inputRefs: [...inputRefs],
          ...(resultDelivery ? { resultDelivery } : null),
        },
      },
      new AbortController().signal,
    ),
  );
  return yield* Schema.decodeUnknownEffect(Schema.Struct({ sessionId: Schema.String }))(result);
});

const onlyTurn = Effect.fn("SpawnedReportingTest.onlyTurn")(function* () {
  const state = yield* (yield* SessionFamilyStorage).state();
  const turns = state.turns;
  assert.equal(turns.length, 1);
  const turn = turns[0];
  assert.ok(turn);
  return turn;
});

describe("automatic spawned-session reporting", () => {
  for (const coordinator of [CAKE_CHAT_SESSION_ID, projectChatSessionId("/project")]) {
    it.effect.each([false, true])(
      `Expect reply wakes or serially queues linked completion for ${coordinator}, busy=%s`,
      (busy) =>
        Effect.gen(function* () {
          const f = yield* fixture(busy);
          yield* f.run(
            Effect.gen(function* () {
              yield* createFromChat([], "reply", coordinator);
              const admitted = yield* Deferred.await(f.entered);
              assert.equal(
                parseCrossSessionMessage(admitted.text)?.metadata.resultDelivery,
                "reply",
              );
              assert.equal((yield* onlyTurn()).resultDelivery, "reply");
              // Verify the launch fact survives decoding, so pre-admission recovery also knows to resume.
              const reloaded = yield* Effect.gen(function* () {
                return yield* (yield* SessionFamilyStorage).state();
              }).pipe(Effect.provide(familyStorageHarness(f.harness.files).layer));
              assert.equal(reloaded.spawnedSessions[0]?.resultDelivery, "reply");
              const link = "[Commit](cake://session/worker?message=prerequisite)";
              yield* Deferred.succeed(f.finish, {
                stopReason: "stop",
                text: link,
                entryId: "authoritative-result-entry",
              });
              yield* Deferred.await(f.settled);
              const turn = yield* onlyTurn();
              yield* families.deliver(turn);
              yield* Deferred.await(f.received);
              yield* families.deliver(turn); // Retry while active/queued must not add a second input.
              assert.deepEqual(f.deliveries, [busy ? "follow-up" : "prompt"]);
              assert.deepEqual(f.recipients, [coordinator]);
              assert.ok(
                (f.chatTranscripts.get(coordinator)?.[0] ?? f.queue[0] ?? "").includes(
                  messageReference(admitted.sessionId, "authoritative-result-entry"),
                ),
              );
              assert.equal((yield* f.storage.state()).deferredReferences?.length ?? 0, 0);
              assert.equal((yield* f.storage.state()).coordinatorDigest?.length ?? 0, 0);
              yield* Deferred.succeed(f.consumeQueued, undefined);
              yield* Deferred.await(f.persisted);
              yield* families.deliver(turn);
              assert.equal(f.deliveries.length, 1);
            }).pipe(
              Effect.provide(
                Layer.mock(TaskInputStorage, {
                  isRecipient: () => Effect.succeed(false),
                  authorizeForward: () => Effect.succeed([]),
                  grant: () => Effect.succeed([]),
                }),
              ),
            ),
          );
        }),
    );
  }

  it("accepts only persisted visible text after the latest consumed input as acknowledgment evidence", () => {
    const input = {
      id: "input",
      kind: "text" as const,
      role: "user" as const,
      text: "Current question",
      status: "complete" as const,
    };
    const reply = {
      id: "notice",
      kind: "text" as const,
      role: "assistant" as const,
      text: "The investigation is ready.",
      status: "complete" as const,
      entryId: "persisted-entry",
    };
    assert.equal(pendingReports.communicationEvidence([input, reply], reply.text), reply.id);
    assert.equal(pendingReports.communicationEvidence([reply, input], reply.text), undefined);
    assert.equal(
      pendingReports.communicationEvidence([input, { ...reply, status: "streaming" }], reply.text),
      undefined,
    );
    assert.equal(
      pendingReports.communicationEvidence([input, { ...reply, status: "error" }], reply.text),
      undefined,
    );
    assert.equal(
      pendingReports.communicationEvidence([input, { ...reply, entryId: undefined }], reply.text),
      undefined,
    );
    assert.equal(
      pendingReports.communicationEvidence(
        [input, { id: "reasoning", kind: "reasoning", text: reply.text, status: "complete" }],
        reply.text,
      ),
      undefined,
    );
    assert.equal(
      pendingReports.communicationEvidence(
        [input, { id: "context", kind: "context", title: "Intake", text: reply.text }],
        reply.text,
      ),
      undefined,
    );
    assert.equal(
      pendingReports.communicationEvidence(
        [input, { ...reply, role: "user", deliveryState: "queued" }],
        reply.text,
      ),
      undefined,
    );
    assert.equal(pendingReports.communicationEvidence([input, reply], "   "), undefined);
    // This is an explicit attestation anchor, not a test of semantic communication.
  });

  it.effect(
    "replays an omitted substantive worker report after unrelated input, abort and storage reopen until explicit visible handling",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            yield* assembleCoordinator();
            const item = {
              id: "investigation-result",
              recipientSessionId: CAKE_CHAT_SESSION_ID,
              text: "The investigation found the reporting lifecycle regression; no performance changes were made.",
              source: {
                kind: "subagent" as const,
                handleId: "worker-handle",
                sessionId: "worker-pi",
                task: "Investigate missed reporting",
                status: "complete",
              },
            };
            yield* f.storage.deferReferenceNotice(item);
            const send = (text: string) =>
              sessionChats.deliver(
                {
                  sessionId: CAKE_CHAT_SESSION_ID,
                  text,
                  attachments: [],
                  renderUserMessageAsMarkdown: false,
                },
                "prompt",
              );
            yield* send("What does the s: prefix mean?");
            while (f.transcript.length < 1) yield* Effect.yieldNow;
            const firstInput = f.transcript[0];
            assert.ok(firstInput);
            assert.equal(splitContextReminders(firstInput).text, "What does the s: prefix mean?");
            assert.ok(f.transcript[0]?.includes(item.text));
            f.reply("It is a short session reference."); // Omission: a completed unrelated answer is not handling.
            assert.equal((yield* pendingReports.list(CAKE_CHAT_SESSION_ID, {})).total, 1);
            const planned = {
              ids: [item.id],
              disposition: "communicated" as const,
              communicatedText: "The investigation found a reporting regression.",
            };
            assert.equal(
              (yield* Effect.result(pendingReports.acknowledge(CAKE_CHAT_SESSION_ID, planned)))
                ._tag,
              "Failure",
            );
            yield* sessionChats.abort({
              sessionId: CAKE_CHAT_SESSION_ID,
              stop: { by: "user", reason: "user-stop" },
            });
            const reloaded = yield* Effect.gen(function* () {
              return yield* SessionFamilyStorage;
            }).pipe(Effect.provide(familyStorageHarness(f.harness.files).layer));
            assert.equal((yield* reloaded.state()).deferredReferences?.[0]?.admissions, 1);
            yield* send("Continue with my next question").pipe(
              Effect.provideService(SessionFamilyStorage, reloaded),
            );
            while (f.transcript.length < 2) yield* Effect.yieldNow;
            assert.ok(f.transcript[1]?.includes(item.id));
            assert.ok(f.transcript[1]?.includes("pending user-facing handling"));
            // Reading supplies evidence to the model, but is not a user-facing acknowledgment.
            assert.equal(
              (yield* pendingReports.read(CAKE_CHAT_SESSION_ID, { id: item.id })).source?.handleId,
              "worker-handle",
            );
            assert.equal((yield* f.storage.state()).deferredReferences?.length, 1);
            f.reply(planned.communicatedText);
            yield* pendingReports.acknowledge(CAKE_CHAT_SESSION_ID, planned);
            yield* pendingReports.acknowledge(CAKE_CHAT_SESSION_ID, planned); // Idempotent tool retry.
            assert.deepEqual((yield* f.storage.state()).deferredReferences, []);
            assert.equal(
              (yield* f.storage.state()).handledReports?.[0]?.disposition,
              "communicated",
            );
            yield* f.storage.deferReferenceNotice(item); // Old worker checkpoint retry cannot resurrect it.
            yield* send("Another question");
            while (f.transcript.length < 3) yield* Effect.yieldNow;
            assert.equal(f.transcript[2], "Another question");
            assert.equal((yield* pendingReports.list(CAKE_CHAT_SESSION_ID, {})).total, 0);
          }).pipe(
            Effect.provide(
              Layer.mock(TaskInputStorage, { isRecipient: () => Effect.succeed(false) }),
            ),
          ),
        );
      }),
  );

  it.effect(
    "keeps explicit questions, substantive messages and deliberate steering immediate without draining passive references",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            yield* assembleCoordinator();
            const metadata = {
              version: 1 as const,
              messageId: "30000000-0000-4000-8000-000000000001",
              threadId: "30000000-0000-4000-8000-000000000002",
              sequence: 1,
              expectsResponse: false,
              sender: { sessionId: "worker", title: "Worker", kind: "project-session" as const },
            };
            const ref = messageReference("worker", "answer");
            const send = (
              text: string,
              expectsResponse = false,
              delivery = "prompt" as "prompt" | "steer",
            ) =>
              sessionChats.deliver(
                {
                  sessionId: CAKE_CHAT_SESSION_ID,
                  text,
                  attachments: [],
                  renderUserMessageAsMarkdown: false,
                  crossSession: { ...metadata, messageId: crypto.randomUUID(), expectsResponse },
                },
                delivery,
              );
            yield* send(`[Result](${ref})`);
            assert.equal(f.deliveries.length, 0);
            yield* send(`Can you decide which approach to take? ${ref}`, true);
            yield* send(
              `Implemented the change; the failing check needs your investigation. ${ref}`,
            );
            yield* send(ref, false, "steer");
            while (f.deliveries.length < 3) yield* Effect.yieldNow;
            assert.deepEqual(f.deliveries, ["prompt", "prompt", "steer"]);
            assert.equal((yield* f.storage.state()).deferredReferences?.length, 1);
            // A link typed by the local user is itself an input, not a worker notification.
            yield* sessionChats.deliver(
              {
                sessionId: CAKE_CHAT_SESSION_ID,
                text: ref,
                attachments: [],
                renderUserMessageAsMarkdown: false,
              },
              "prompt",
            );
            while (f.deliveries.length < 4) yield* Effect.yieldNow;
            assert.equal((yield* f.storage.state()).deferredReferences?.length, 1);
            assert.equal((yield* f.storage.state()).deferredReferences?.[0]?.admissions, 1);
          }).pipe(
            Effect.provide(
              Layer.mock(TaskInputStorage, { isRecipient: () => Effect.succeed(false) }),
            ),
          ),
        );
      }),
  );

  it.effect(
    "retains exact pending references across storage reload and a failed user-input admission",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            yield* assembleCoordinator();
            const item = {
              id: "notice",
              recipientSessionId: CAKE_CHAT_SESSION_ID,
              text: "[Result](cake://session/worker?message=original%3Aentry)",
            };
            yield* f.storage.deferReferenceNotice(item);
            const reloaded = yield* Effect.gen(function* () {
              return yield* (yield* SessionFamilyStorage).state();
            }).pipe(Effect.provide(familyStorageHarness(f.harness.files).layer));
            assert.deepEqual(reloaded.deferredReferences, [item]);
            const handle = yield* (yield* CakeSessionRuntimes).acquireSession(CAKE_CHAT_SESSION_ID);
            yield* sessionChats
              .deliver(
                {
                  sessionId: CAKE_CHAT_SESSION_ID,
                  text: "Continue",
                  attachments: [],
                  renderUserMessageAsMarkdown: false,
                },
                "prompt",
              )
              .pipe(
                Effect.provide(
                  Layer.mock(CakeSessionRuntimes, {
                    acquireSession: () =>
                      Effect.succeed({
                        ...handle,
                        prompt: () =>
                          Effect.fail(
                            new PiSessionError({
                              operation: "prompt",
                              message: "Admission rejected",
                            }),
                          ),
                      }),
                  }),
                ),
                Effect.flip,
              );
            assert.deepEqual((yield* f.storage.state()).deferredReferences, [item]);
            assert.deepEqual(f.deliveries, []);
          }),
        );
      }),
  );

  it.effect.each(["interrupt", "blocked", "resume-failed"] as const)(
    "preserves intentional immediate %s result delivery even when the report is only a reference",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            yield* assembleCoordinator();
            const turn = {
              turnId: "40000000-0000-4000-8000-000000000001",
              sessionId: "worker",
              senderSessionId: CAKE_CHAT_SESSION_ID,
              requestMessageId: "40000000-0000-4000-8000-000000000002",
              threadId: "40000000-0000-4000-8000-000000000003",
              reported: false,
              outcome: "complete" as const,
              resultDelivery: mode === "blocked" ? ("notification" as const) : ("reply" as const),
              report: {
                outcome:
                  mode === "blocked"
                    ? ("blocked" as const)
                    : mode === "resume-failed"
                      ? ("failed" as const)
                      : ("completed" as const),
                text: "[Result](cake://session/worker?message=entry)",
              },
            };
            yield* f.storage.recordTurn(turn);
            yield* families.deliver(turn);
            yield* Deferred.await(f.received);
            assert.deepEqual(f.deliveries, ["prompt"]);
            assert.equal((yield* f.storage.state()).deferredReferences?.length ?? 0, 0);
            assert.ok(f.transcript[0]?.includes(turn.report.text));
          }).pipe(
            Effect.provide(
              Layer.mock(TaskInputStorage, { isRecipient: () => Effect.succeed(false) }),
            ),
          ),
        );
      }),
  );

  it.effect(
    "does not turn Project Session commands or shell escapes into model inputs while references wait",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            yield* (yield* CakeSessionRuntimes).acquire(
              yield* projectOptions({ location, sessionId: parentId, newSession: false }),
            );
            yield* f.storage.deferReferenceNotice({
              id: "notice",
              recipientSessionId: parentId,
              text: "[Result](cake://session/worker?message=entry)",
            });
            for (const text of ["/compact", "!pwd"])
              yield* sessionChats.deliver(
                { sessionId: parentId, text, attachments: [], renderUserMessageAsMarkdown: false },
                "prompt",
              );
            while (f.transcript.length < 2) yield* Effect.yieldNow;
            assert.deepEqual(f.transcript, ["/compact", "!pwd"]);
            assert.equal((yield* f.storage.state()).deferredReferences?.length, 1);
          }),
        );
      }),
  );

  for (const busy of [false, true]) {
    it.effect.each([CAKE_CHAT_SESSION_ID, projectChatSessionId("/project"), parentId])(
      `defers exact result references for ${busy ? "active" : "idle"} parent %s until its next user input`,
      (recipientSessionId) =>
        Effect.gen(function* () {
          const f = yield* fixture(busy);
          yield* f.run(
            Effect.gen(function* () {
              const isChat = isCakeChatSessionId(recipientSessionId);
              if (isChat) yield* assembleCoordinator(recipientSessionId);
              else
                yield* (yield* CakeSessionRuntimes).acquire(
                  yield* projectOptions({
                    location,
                    sessionId: recipientSessionId,
                    newSession: false,
                  }),
                );
              const refs: string[] = [];
              for (let index = 0; index < 2; index += 1) {
                const childId = `20000000-0000-4000-8000-00000000000${index}`;
                const ref = messageReference(childId, `entry-${index}-${"€".repeat(100)}`);
                refs.push(ref);
                if (!isChat)
                  yield* f.storage.addChild({
                    familyId: "reference-family",
                    parentSessionId: recipientSessionId,
                    parentWorkingDirectory: "/project",
                    childSessionId: childId,
                    childWorkingDirectory: "/project",
                    requestId: childId,
                    projectPath: "/project",
                    createdAt: "2026-01-01",
                  });
                const turn = {
                  sessionId: childId,
                  senderSessionId: recipientSessionId,
                  turnId: childId,
                  requestMessageId: childId,
                  threadId: childId,
                  reported: false,
                  outcome: "complete" as const,
                  resultDelivery: "notification" as const,
                  report: {
                    outcome: "completed" as const,
                    text: `[Artifact](cake://artifact/drawing-${index})`,
                    resultMessageRef: ref,
                  },
                };
                yield* f.storage.recordTurn(turn);
                yield* families.deliver(turn);
                yield* families.deliver(turn); // A retry cannot create another pending notification.
              }
              assert.deepEqual(f.deliveries, []);
              assert.deepEqual(f.queue, []);
              const before = yield* f.storage.state();
              assert.equal(before.deferredReferences?.length ?? 0, 0);
              assert.equal(before.coordinatorDigest?.length, 2);
              assert.equal(before.completionInbox?.length, 2);
              assert.deepEqual(before.turns, []);
              const send = (text: string) =>
                sessionChats.deliver(
                  {
                    sessionId: recipientSessionId,
                    text,
                    attachments: [],
                    renderUserMessageAsMarkdown: false,
                  },
                  busy ? "follow-up" : "prompt",
                );
              yield* send("My next question");
              yield* Deferred.await(f.received);
              const submitted = busy
                ? f.queue[0]
                : (f.chatTranscripts.get(recipientSessionId) ?? f.transcript)[0];
              assert.ok(submitted);
              assert.equal(splitContextReminders(submitted).text, "My next question");
              for (const ref of refs) assert.equal(submitted.split(ref).length - 1, 1);
              assert.equal(f.deliveries.length, 1);
              assert.equal((yield* f.storage.state()).deferredReferences?.length ?? 0, 0);
              assert.deepEqual((yield* f.storage.state()).coordinatorDigest, []);
              yield* Deferred.succeed(f.consumeQueued, undefined);
              yield* send("Another question");
              while (f.deliveries.length < 2) yield* Effect.yieldNow;
              assert.equal(f.deliveries.length, 2);
              const transcript = f.chatTranscripts.get(recipientSessionId) ?? f.transcript;
              while (transcript.length < 2) yield* Effect.yieldNow;
              assert.equal(transcript[1], "Another question");
            }).pipe(
              Effect.provide(
                Layer.mock(TaskInputStorage, {
                  isRecipient: () => Effect.succeed(false),
                }),
              ),
            ),
          );
        }),
    );
  }

  it.effect.each([CAKE_CHAT_SESSION_ID, projectChatSessionId("/project")])(
    "inspects permanent chat history at its own address: %s",
    (sessionId) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            const options = yield* assembleCoordinator(sessionId);
            const result = yield* Effect.promise(() =>
              options.runtime.globalControl!.invoke(
                { name: "sessions.history", arguments: { sessionId } },
                new AbortController().signal,
              ),
            );
            assert.deepEqual(
              Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Json }))(result).result,
              { kind: "history", sessionId },
            );
          }),
        );
      }),
  );
  const setupWorkboard = Effect.fn("ReportingTest.setupWorkboard")(function* () {
    const storage = yield* SessionFamilyStorage;
    for (const child of ["worker-a", "worker-b"])
      yield* storage.addChild({
        familyId: "board-family",
        parentSessionId: parentId,
        parentWorkingDirectory: "/project",
        childSessionId: child,
        childWorkingDirectory: "/isolated-tree",
        requestId: child,
        projectPath: "/project",
        createdAt: "2026-01-01",
      });
    const family = yield* storage.familyForMember(parentId);
    assert.ok(family);
    yield* boards.ensureBoard(family);
    yield* (yield* CakeSessionRuntimes).acquire(
      yield* projectOptions({ location, sessionId: parentId, newSession: false }),
    );
  });
  const boardResult = (author: string, event: "completion" | "blocker" = "completion") =>
    boards.append(author, {
      audience: [parentId],
      topic: "batch",
      event,
      resultKind: "ready",
      description: event === "blocker" ? "Needs a decision" : `Ready ${author}`,
      body: "Evidence lives on the board.",
    });

  it.effect(
    "Workboard-only results stay passive and become one quiet grouped notice with retained decisions",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            yield* setupWorkboard();
            yield* boardResult("worker-a");
            yield* boardResult("worker-b", "blocker");
            yield* workboardContinuations.runPass();
            assert.deepEqual(f.deliveries, []);
            assert.deepEqual((yield* f.storage.state()).turns, []);
            assert.equal((yield* completionInbox.list(parentId)).items.length, 2);
            yield* sessionChats.deliver(
              {
                sessionId: parentId,
                text: "My current question",
                attachments: [],
                renderUserMessageAsMarkdown: false,
              },
              "prompt",
            );
            yield* Deferred.await(f.received);
            const text = f.transcript[0]!;
            assert.equal(text.split("Cake session updates").length - 1, 1);
            assert.equal(splitContextReminders(text).text, "My current question");
            assert.match(text, /current message first/);
            assert.match(text, /ready/);
            assert.match(text, /blocked/);
            assert.match(text, /pending decisions: review, merge, resolve, next-step/);
            assert.match(text, /not authorization/);
            assert.equal((yield* completionInbox.list(parentId)).total, 2);
            const first = (yield* completionInbox.list(parentId)).items[0]!;
            yield* completionInbox.update("other-recipient", { id: first.id, state: "dismissed" });
            assert.equal((yield* completionInbox.list(parentId)).items[0]?.state, "pending");
            yield* completionInbox.update(parentId, { id: first.id, state: "deferred" });
            yield* workboardContinuations.runPass();
            yield* sessionChats.deliver(
              {
                sessionId: parentId,
                text: "Next question",
                attachments: [],
                renderUserMessageAsMarkdown: false,
              },
              "prompt",
            );
            while (f.transcript.length < 2) yield* Effect.yieldNow;
            assert.equal(f.transcript[1], "Next question");
            assert.equal((yield* completionInbox.list(parentId)).items[0]?.state, "deferred");
          }).pipe(
            Effect.provide(
              Layer.mock(TaskInputStorage, { isRecipient: () => Effect.succeed(false) }),
            ),
          ),
        );
      }),
  );

  it.effect.each([false, true])("Workboard batch is bounded and coalesced; busy=%s", (busy) =>
    Effect.gen(function* () {
      const f = yield* fixture(busy);
      yield* f.run(
        Effect.gen(function* () {
          yield* setupWorkboard();
          yield* boards.setContinuation(
            parentId,
            { mode: "resume", topic: "batch", awaitAuthors: ["worker-a", "worker-b"], maxTurns: 1 },
            "grant-1",
          );
          yield* boardResult("worker-a");
          yield* workboardContinuations.runPass();
          assert.deepEqual(f.deliveries, []);
          yield* boardResult("worker-b");
          yield* workboardContinuations.runPass();
          if (busy) {
            assert.deepEqual(f.deliveries, []);
            assert.equal((yield* boards.continuation(parentId)).policy?.remainingTurns, 1);
            return;
          }
          yield* Deferred.await(f.received);
          assert.deepEqual(f.deliveries, ["follow-up"]);
          assert.match(f.queue[0]!, /#1, #2/);
          assert.ok(f.queue[0]!.includes("No private result/report obligation"));
          const staged = (yield* boards.continuation(parentId)).policy!;
          assert.equal(staged.remainingTurns, 0);
          assert.deepEqual(staged.completedAuthors, ["worker-a", "worker-b"]);
          yield* workboardContinuations.runPass();
          assert.equal(
            (yield* boards.continuation(parentId)).policy?.pending?.turnId,
            staged.pending?.turnId,
          );
          assert.equal(f.deliveries.length, 1);
          assert.deepEqual((yield* f.storage.state()).turns, []);
          yield* Deferred.succeed(f.consumeQueued, undefined);
          yield* Deferred.await(f.persisted);
          const handle = yield* (yield* CakeSessionRuntimes).acquire(
            yield* projectOptions({ location, sessionId: parentId, newSession: false }),
          );
          while ((yield* handle.currentTurnIds()).length) yield* Effect.yieldNow;
          yield* workboardContinuations.runPass();
          assert.equal((yield* boards.continuation(parentId)).policy?.after, 2);
          yield* boardResult("worker-a");
          yield* workboardContinuations.runPass();
          assert.equal(f.deliveries.length, 1);
        }),
      );
    }),
  );

  it.effect(
    "a Workboard blocker breaks the batch barrier, and canceled admission pauses instead of replaying",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            yield* setupWorkboard();
            yield* boards.setContinuation(
              parentId,
              {
                mode: "resume",
                topic: "batch",
                awaitAuthors: ["worker-a", "worker-b"],
                maxTurns: 2,
              },
              "grant",
            );
            yield* boardResult("worker-a", "blocker");
            yield* workboardContinuations.runPass();
            yield* Deferred.await(f.received);
            const staged = (yield* boards.continuation(parentId)).policy!.pending!;
            const handle = yield* (yield* CakeSessionRuntimes).acquire(
              yield* projectOptions({ location, sessionId: parentId, newSession: false }),
            );
            yield* handle.removeQueuedMessage(staged.turnId);
            while ((yield* handle.currentTurnIds()).length) yield* Effect.yieldNow;
            yield* workboardContinuations.runPass();
            const paused = (yield* boards.continuation(parentId)).policy!;
            assert.equal(paused.mode, "paused");
            assert.deepEqual(paused.lastDelivery, { turnId: staged.turnId, status: "canceled" });
            yield* boardResult("worker-b");
            yield* workboardContinuations.runPass();
            assert.equal(f.deliveries.length, 1);
            assert.deepEqual((yield* f.storage.state()).turns, []);
          }),
        );
      }),
  );

  it.effect(
    "a saved-but-not-admitted Workboard input survives storage reconstruction and deduplicates retry",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            yield* setupWorkboard();
            yield* boards.setContinuation(parentId, { mode: "resume", maxTurns: 1 }, "grant");
            yield* boardResult("worker-a");
            const turnId = "30000000-0000-4000-8000-000000000001";
            yield* f.storage.changeBoardContinuation(
              parentId,
              (current) =>
                current && {
                  ...current,
                  remainingTurns: 0,
                  pending: { turnId, sequences: [1], through: 1 },
                },
            );
            const restartedContext = yield* Layer.build(
              familyStorageHarness(f.harness.files).layer,
            );
            const restarted = yield* SessionFamilyStorage.pipe(Effect.provide(restartedContext));
            const pass = workboardContinuations
              .runPass()
              .pipe(Effect.provideService(SessionFamilyStorage, restarted));
            yield* pass;
            yield* Deferred.await(f.received);
            yield* pass;
            assert.equal(f.deliveries.length, 1);
            assert.equal(
              (yield* restarted.state()).boardContinuations?.[0]?.pending?.turnId,
              turnId,
            );
            assert.deepEqual((yield* restarted.state()).turns, []);
          }),
        );
      }),
  );

  it.effect("superseded staged board work is canceled without a parent turn", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.run(
        Effect.gen(function* () {
          yield* setupWorkboard();
          yield* boards.setContinuation(parentId, { mode: "resume" }, "grant");
          yield* boardResult("worker-a");
          yield* f.storage.changeBoardContinuation(
            parentId,
            (current) =>
              current && {
                ...current,
                remainingTurns: 0,
                pending: {
                  turnId: "30000000-0000-4000-8000-000000000002",
                  sequences: [1],
                  through: 1,
                },
              },
          );
          yield* boards.append("worker-a", {
            audience: [parentId],
            topic: "batch",
            supersedes: [1],
            description: "Withdrawn",
            body: "Not ready.",
          });
          yield* workboardContinuations.runPass();
          assert.deepEqual(f.deliveries, []);
          assert.equal(
            (yield* boards.continuation(parentId)).policy?.lastDelivery?.status,
            "canceled",
          );
        }),
      );
    }),
  );

  it.effect(
    "Workboard grants are idempotent, explicitly pausable, and globally capped at two outstanding inputs",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            yield* setupWorkboard();
            yield* boards.setContinuation(parentId, { mode: "resume", maxTurns: 1 }, "grant");
            yield* boardResult("worker-a");
            const base = (yield* boards.continuation(parentId)).policy!;
            for (const id of ["other-1", "other-2"])
              yield* f.storage.changeBoardContinuation(id, () => ({
                ...base,
                recipientSessionId: id,
                pending: { turnId: crypto.randomUUID(), sequences: [1], through: 1 },
              }));
            yield* workboardContinuations.runPass();
            assert.deepEqual(f.deliveries, []);
            assert.equal((yield* boards.continuation(parentId)).policy?.remainingTurns, 1);
            yield* boards.setContinuation(parentId, { mode: "paused" }, "pause");
            yield* boards.setContinuation(parentId, { mode: "resume", maxTurns: 10 }, "pause");
            assert.equal((yield* boards.continuation(parentId)).policy?.mode, "paused");
            yield* workboardContinuations.runPass();
            assert.deepEqual(f.deliveries, []);
          }),
        );
      }),
  );

  it.effect("isolates Project Chat digests and immediate reports from global Cake Chat", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.run(
        Effect.gen(function* () {
          const projectId = projectChatSessionId("/project");
          yield* assembleCoordinator();
          yield* assembleCoordinator(projectId);
          for (const [index, senderSessionId] of [CAKE_CHAT_SESSION_ID, projectId].entries()) {
            yield* f.storage.recordTurn({
              turnId: "digest-" + index,
              sessionId: "task-" + index,
              senderSessionId,
              requestMessageId: "request-" + index,
              threadId: "thread-" + index,
              reported: false,
              outcome: "complete",
              resultDelivery: "notification",
              report: {
                outcome: "completed",
                text: index === 0 ? "GLOBAL_RESULT" : "PROJECT_RESULT",
              },
            });
          }
          for (const turn of (yield* f.storage.state()).turns) yield* families.deliver(turn);
          assert.equal(f.deliveries.length, 0);
          const send = (sessionId: string) =>
            sessionChats
              .deliver(
                {
                  sessionId,
                  text: "Continue",
                  attachments: [],
                  renderUserMessageAsMarkdown: false,
                },
                "prompt",
              )
              .pipe(Effect.provide(Layer.mock(TaskInputStorage, {})));
          yield* send(CAKE_CHAT_SESSION_ID);
          while (!f.transcript.length) yield* Effect.yieldNow;
          assert.ok(f.transcript[0]?.includes("GLOBAL_RESULT"));
          assert.ok(!f.transcript[0]?.includes("PROJECT_RESULT"));
          assert.equal((yield* f.storage.state()).coordinatorDigest?.length, 1);
          yield* send(projectId);
          while (!f.chatTranscripts.get(projectId)?.length) yield* Effect.yieldNow;
          const projectMessage = f.chatTranscripts.get(projectId)![0]!;
          assert.ok(projectMessage.includes("PROJECT_RESULT"));
          assert.ok(!projectMessage.includes("GLOBAL_RESULT"));
          assert.deepEqual((yield* f.storage.state()).coordinatorDigest, []);

          yield* f.storage.recordTurn({
            turnId: "10000000-0000-4000-8000-000000000001",
            sessionId: "task-project",
            senderSessionId: projectId,
            requestMessageId: "10000000-0000-4000-8000-000000000002",
            threadId: "10000000-0000-4000-8000-000000000003",
            reported: false,
            outcome: "complete",
            resultDelivery: "reply",
            report: { outcome: "blocked", text: "PROJECT_NEEDS_DECISION" },
          });
          const [turn] = (yield* f.storage.state()).turns;
          assert.ok(turn);
          yield* families.deliver(turn).pipe(
            Effect.provide(
              Layer.mock(CakeChatComposerPresence, {
                holdsInterrupts: (sessionId) => Effect.succeed(sessionId === CAKE_CHAT_SESSION_ID),
              }),
            ),
          );
          while (f.chatTranscripts.get(projectId)!.length < 2) yield* Effect.yieldNow;
          assert.equal(f.recipients.at(-1), projectId);
          assert.ok(f.chatTranscripts.get(projectId)!.at(-1)!.includes("PROJECT_NEEDS_DECISION"));
          assert.equal(f.transcript.length, 1);
        }),
      );
    }),
  );
  it.effect.each(["completion", "explicit"] as const)(
    "forwards selected inputs through backend creation and isolates %s reports without losing correlation",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const ref = "00000000-0000-4000-8000-000000000004";
        const grant = `${ref}/00000000-0000-4000-8000-000000000005`;
        const recipients = new Set<string>();
        const original: Attachment = {
          kind: "file",
          name: "build.log",
          path: "/vault/PRIVATE_ORIGINAL.log",
        };
        const inputs = TaskInputStorage.of({
          isolate: () => Effect.die("Creation must not copy the input into Cake Chat"),
          grant: () => Effect.die("not used"),
          list: () => Effect.die("not used"),
          inspect: () => Effect.die("not used"),
          authorizeForward: (owner, ids) =>
            Effect.sync(() => {
              assert.equal(owner, CAKE_CHAT_SESSION_ID);
              assert.deepEqual(ids, [ref]);
              return [grant];
            }),
          resolve: (recipient, attachments) =>
            Effect.sync(() => {
              assert.deepEqual(attachments, [
                { kind: "forwarded-input", name: "Attachment", reference: grant },
              ]);
              recipients.add(recipient);
              return [original];
            }),
          isRecipient: (id) => Effect.succeed(recipients.has(id)),
          protectRecipient: (id) =>
            Effect.sync(() => {
              recipients.add(id);
            }),
        });
        yield* f.run(
          Effect.gen(function* () {
            const created = yield* createFromChat([ref]);
            const entered = yield* Deferred.await(f.entered);
            assert.equal(entered.sessionId, created.sessionId);
            assert.deepEqual(f.submittedAttachments.get(created.sessionId), [original]);
            assert.equal(parseCrossSessionMessage(entered.text)?.metadata.sender.kind, "cake-chat");
            const request = yield* onlyTurn();
            if (mode === "completion") {
              yield* Deferred.succeed(f.finish, {
                stopReason: "stop",
                text: "PRIVATE_DERIVED_RESULT",
              });
              yield* Deferred.await(f.settled);
              yield* families.deliver(yield* onlyTurn());
            } else {
              yield* families.routeCoordinatorMessage(
                created.sessionId,
                "sessions.send",
                {
                  sessionId: CAKE_CHAT_SESSION_ID,
                  text: "PRIVATE_DERIVED_QUESTION",
                  resultDelivery: "reply",
                },
                location,
              );
            }
            yield* Deferred.await(f.received);
            const response = parseCrossSessionMessage(f.transcript[0] ?? "");
            assert.ok(response);
            assert.doesNotMatch(JSON.stringify(response), /PRIVATE_/);
            assert.match(response.text, /Open the Project Session/);
            assert.equal(response.metadata.sender.sessionId, created.sessionId);
            assert.equal(response.metadata.sender.title, "Task session");
            if (mode === "completion") {
              assert.equal(response.metadata.replyToMessageId, request.requestMessageId);
              yield* families.deliver(yield* onlyTurn());
              assert.equal((yield* f.storage.state()).spawnedSessions[0]?.reportDelivered, true);
            } else {
              assert.equal(response.metadata.expectsResponse, true);
              yield* Deferred.succeed(f.finish, {
                stopReason: "stop",
                text: "PRIVATE_DERIVED_RESULT",
              });
              yield* Deferred.await(f.settled);
            }
          }).pipe(Effect.provideService(TaskInputStorage, inputs)),
        );
      }),
  );
  it.effect.each([
    { destination: "cake-chat", action: "remove" },
    { destination: "cake-chat", action: "clear" },
    { destination: "cake-chat", action: "steering" },
    { destination: "project", action: "remove" },
    { destination: "project", action: "clear" },
    { destination: "project", action: "steering" },
  ] as const)(
    "$destination: withdrawing a child report with $action survives delivery retries and journal reload",
    ({ destination, action }) =>
      Effect.gen(function* () {
        const f = yield* fixture(true);
        yield* f.run(
          Effect.gen(function* () {
            const sessionId = destination === "cake-chat" ? CAKE_CHAT_SESSION_ID : parentId;
            if (destination === "cake-chat") yield* createFromChat([], "reply");
            else {
              const root = yield* projectOptions({ location, sessionId, newSession: false });
              yield* (yield* CakeSessionRuntimes).acquire(root);
              yield* Effect.promise(() =>
                root.runtime.currentSessionControl!.createChildSession!(
                  {
                    requestId: "cancel-child",
                    resultDelivery: "reply",
                    title: "Child",
                    initialPrompt: createArgs.initialPrompt,
                    model: configuration,
                    placement: "none",
                    senderContext: { usedTokens: null, windowTokens: null },
                  },
                  new AbortController().signal,
                ),
              );
            }
            yield* Deferred.await(f.entered);
            yield* Deferred.succeed(f.finish, { stopReason: "stop", text: resultText });
            yield* Deferred.await(f.settled);
            const turn = yield* onlyTurn();
            yield* families.deliver(turn);
            yield* Deferred.await(f.received);
            const handle = yield* (yield* CakeSessionRuntimes).acquireSession(sessionId);
            const [report] = (yield* handle.pendingMessages()).items;
            assert.ok(report?.crossSession && report.partId);
            // A queued card is not a consumed receipt; background retries must keep it once.
            yield* families.deliver(turn);
            assert.equal((yield* onlyTurn()).reported, false);
            assert.equal(f.deliveries.length, 1);
            if (action === "steering") {
              yield* sessionChats.steerQueuedMessage({ sessionId }, report.partId);
              yield* sessionChats.cancelSteering({ sessionId });
            } else if (action === "clear") yield* sessionChats.clearQueue({ sessionId });
            else {
              f.beforeRemove(async () => {
                throw new Error("Queue removal failed");
              });
              const rejected = yield* Effect.result(
                sessionChats.removeQueuedMessage({ sessionId }, report.partId),
              );
              assert.equal(rejected._tag, "Failure");
              assert.equal((yield* onlyTurn()).turnId, turn.turnId);
              assert.equal((yield* handle.pendingMessages()).items.length, 1);
              const removing = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              f.beforeRemove(() =>
                Effect.runPromise(
                  Effect.gen(function* () {
                    yield* Deferred.succeed(removing, undefined);
                    yield* Deferred.await(release);
                  }),
                ),
              );
              const cancellation = yield* sessionChats
                .removeQueuedMessage({ sessionId }, report.partId)
                .pipe(Effect.forkScoped);
              yield* Deferred.await(removing);
              const retry = yield* families.deliver(turn).pipe(Effect.forkScoped);
              yield* Deferred.succeed(release, undefined);
              yield* Fiber.join(cancellation);
              yield* Fiber.join(retry);
            }
            assert.deepEqual((yield* handle.pendingMessages()).items, []);
            assert.ok(
              !(yield* f.storage.state()).turns.some((item) => item.turnId === turn.turnId),
            );
            // Even an already-read worker pass cannot re-submit the withdrawn report.
            yield* families.deliver(turn);
            assert.equal(f.deliveries.length, 1);
            yield* Deferred.succeed(f.consumeQueued, undefined);
            assert.deepEqual(f.transcript, []);
            yield* Effect.gen(function* () {
              const storage = yield* SessionFamilyStorage;
              assert.ok(
                !(yield* storage.state()).turns.some((item) => item.turnId === turn.turnId),
              );
              yield* families.deliver(turn);
              assert.equal(f.deliveries.length, 1);
              if (destination === "cake-chat") {
                const spawn = (yield* storage.state()).spawnedSessions[0];
                assert.equal(spawn?.handoffSettled, true);
                assert.equal(spawn?.reportDelivered, false);
              }
            }).pipe(Effect.provide(familyStorageHarness(f.harness.files).layer));
          }),
        );
      }),
  );

  it.effect.each([false, true])(
    "global creation records origin and delivers/wakes idle or busy Cake Chat (%s)",
    (busy) =>
      Effect.gen(function* () {
        const f = yield* fixture(busy);
        yield* f.run(
          Effect.gen(function* () {
            const created = yield* createFromChat();
            const entered = yield* Deferred.await(f.entered);
            assert.equal(entered.sessionId, created.sessionId);
            assert.equal(parseCrossSessionMessage(entered.text)?.metadata.sender.kind, "cake-chat");
            assert.equal(parseCrossSessionMessage(entered.text)?.text, createArgs.initialPrompt);
            const state = yield* f.storage.state();
            assert.equal(state.families.length, 0);
            assert.equal(state.spawnedSessions[0]?.requester.sessionId, CAKE_CHAT_SESSION_ID);
            assert.equal(state.turns.length, 1);
            // Admission/ordinary idle is not completion; no successful report exists before Pi settles.
            yield* families.deliver(yield* onlyTurn());
            assert.equal(f.deliveries.length, 0);
            yield* Deferred.succeed(f.finish, { stopReason: "stop", text: resultText });
            yield* Deferred.await(f.settled);
            const turn = yield* onlyTurn();
            yield* families.deliver(turn);
            yield* Deferred.await(f.received);
            assert.deepEqual(f.deliveries, [busy ? "follow-up" : "prompt"]);
            // Repeated passes while queued/accepted must not deliver again.
            yield* families.deliver(turn);
            assert.equal(f.deliveries.length, 1);
            yield* Deferred.succeed(f.consumeQueued, undefined);
            // The runtime can still be consuming the queue. Wait for its turn to settle deterministically.
            const destination = yield* (yield* CakeSessionRuntimes).acquireSession(
              CAKE_CHAT_SESSION_ID,
            );
            yield* Deferred.await(f.persisted);
            const parsed = parseCrossSessionMessage(f.transcript[0] ?? "");
            assert.ok(parsed);
            assert.match(parsed.text, /— result/);
            assert.doesNotMatch(parsed.text, /— completed/);
            assert.ok(parsed.text.includes(resultText));
            assert.equal(parsed.metadata.expectsResponse, false);
            assert.equal(parsed.metadata.replyToMessageId, turn.requestMessageId);
            assert.equal(parsed.metadata.generatedNotice, false);
            assert.equal(destination.profile, "CakeChatSession");
            yield* families.deliver(turn);
            assert.equal((yield* f.storage.state()).turns.length, 0);
            assert.equal((yield* f.storage.state()).spawnedSessions[0]?.reportDelivered, true);
            assert.equal(f.deliveries.length, 1);
          }),
        );
        // Re-open the real persisted journal, not a shared in-memory test projection.
        yield* Effect.gen(function* () {
          const state = yield* (yield* SessionFamilyStorage).state();
          assert.equal(state.spawnedSessions[0]?.requester.kind, "cake-chat");
          assert.equal(state.spawnedSessions[0]?.reportDelivered, true);
          assert.equal(state.turns.length, 0);
        }).pipe(Effect.provide(familyStorageHarness(f.harness.files).layer));
      }),
  );

  it.effect.each(["project", "family-root", "manual"] as const)(
    "%s -> independent Project Session does not acquire a reporting contract",
    (origin) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            yield* assembleCoordinator();
            if (origin !== "manual") {
              if (origin === "family-root")
                yield* f.storage.addChild({
                  familyId: "source-family",
                  parentSessionId: parentId,
                  parentWorkingDirectory: "/project",
                  childSessionId: "existing-child",
                  childWorkingDirectory: "/project",
                  requestId: "existing-child",
                  projectPath: "/project",
                  createdAt: "2026-01-01",
                });
              const options = yield* projectOptions({
                location,
                sessionId: parentId,
                newSession: false,
              });
              assert.ok(options.runtime.currentSessionControl?.createSession);
              yield* Effect.promise(() =>
                options.runtime.currentSessionControl!.createSession!(
                  createArgs,
                  new AbortController().signal,
                ),
              );
            } else yield* createPrompted({ ...createArgs, projectPath: "/project" });
            const entered = yield* Deferred.await(f.entered);
            assert.equal(entered.text, createArgs.initialPrompt);
            assert.equal((yield* f.storage.state()).spawnedSessions.length, 0);
            assert.equal((yield* f.storage.state()).turns.length, 0);
            yield* Deferred.succeed(f.finish, { stopReason: "stop", text: resultText });
            yield* Deferred.await(f.settled);
            assert.equal((yield* f.storage.state()).turns.length, 0);
            assert.equal(f.deliveries.length, 0);
          }),
        );
      }),
  );

  it.effect("family children automatically report to their actual parent, not Cake Chat", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.run(
        Effect.gen(function* () {
          yield* assembleCoordinator();
          const sessions = yield* CakeSessionRuntimes;
          const options = yield* projectOptions({
            location,
            sessionId: parentId,
            newSession: false,
          });
          yield* sessions.acquire(options);
          assert.ok(options.runtime.currentSessionControl?.createChildSession);
          yield* Effect.promise(() =>
            options.runtime.currentSessionControl!.createChildSession!(
              {
                requestId: "create-child",
                title: "Child",
                initialPrompt: createArgs.initialPrompt,
                model: configuration,
                placement: "none",
                senderContext: { usedTokens: null, windowTokens: null },
              },
              new AbortController().signal,
            ),
          );
          yield* Deferred.await(f.entered);
          assert.equal((yield* onlyTurn()).senderSessionId, parentId);
          yield* Deferred.succeed(f.finish, { stopReason: "stop", text: resultText });
          yield* Deferred.await(f.settled);
          const turn = yield* onlyTurn();
          yield* families.deliver(turn);
          yield* Deferred.await(f.received);
          const parsed = parseCrossSessionMessage(f.transcript[0] ?? "");
          assert.ok(parsed?.text.includes(resultText));
          assert.equal(parsed?.metadata.replyToMessageId, turn.requestMessageId);
          assert.equal((yield* f.storage.state()).spawnedSessions.length, 0);
        }),
      );
    }),
  );

  it.effect.each(["family", "cake-chat"] as const)(
    "%s: a final answer to the local user is never forwarded as the requester's result",
    (origin) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const userFacing =
          "You're right—I sent far too many coordination messages. I'll stop messaging the parent.";
        yield* f.run(
          Effect.gen(function* () {
            if (origin === "cake-chat") yield* createFromChat();
            else {
              const root = yield* projectOptions({
                location,
                sessionId: parentId,
                newSession: false,
              });
              yield* (yield* CakeSessionRuntimes).acquire(root);
              yield* Effect.promise(() =>
                root.runtime.currentSessionControl!.createChildSession!(
                  {
                    requestId: "local-answer-child",
                    title: "Child",
                    initialPrompt: createArgs.initialPrompt,
                    model: configuration,
                    placement: "none",
                    senderContext: { usedTokens: null, windowTokens: null },
                  },
                  new AbortController().signal,
                ),
              );
            }
            yield* Deferred.await(f.entered);
            // The user typed into the child while its delegated run was active; Pi consumed
            // that input into the same run, so the final answer addresses the user.
            yield* Deferred.succeed(f.finish, {
              stopReason: "stop",
              text: userFacing,
              respondsToSessionId: undefined,
            });
            yield* Deferred.await(f.settled);
            const turn = yield* onlyTurn();
            assert.equal(turn.outcome, "complete");
            assert.equal(turn.report, undefined);
            yield* families.deliver(turn);
            yield* Deferred.await(f.received);
            assert.equal(f.transcript.length, 1);
            const notice = parseCrossSessionMessage(f.transcript[0] ?? "");
            assert.ok(notice);
            assert.equal(notice.metadata.generatedNotice, true);
            assert.equal(notice.metadata.expectsResponse, false);
            assert.doesNotMatch(notice.text, /— result/);
            assert.ok(!f.transcript.some((content) => content.includes(userFacing)));
            yield* families.deliver(turn);
            assert.equal(f.deliveries.length, 1);
          }),
        );
      }),
  );

  it.effect(
    "a family's queued explicit reply stays durable until the parent's transcript proves receipt",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(true);
        yield* f.run(
          Effect.gen(function* () {
            const root = yield* projectOptions({
              location,
              sessionId: parentId,
              newSession: false,
            });
            yield* (yield* CakeSessionRuntimes).acquire(root);
            yield* Effect.promise(() =>
              root.runtime.currentSessionControl!.createChildSession!(
                {
                  requestId: "queued-child",
                  title: "Child",
                  initialPrompt: createArgs.initialPrompt,
                  model: configuration,
                  placement: "none",
                  senderContext: { usedTokens: null, windowTokens: null },
                },
                new AbortController().signal,
              ),
            );
            const entered = yield* Deferred.await(f.entered);
            const child = yield* projectOptions({
              location,
              sessionId: entered.sessionId,
              newSession: false,
            });
            yield* Effect.promise(() =>
              child.runtime.currentSessionControl!.routeFamilyMessage!(
                "sessions.reply",
                { text: resultText },
                new AbortController().signal,
              ),
            );
            yield* Deferred.await(f.received);
            yield* Deferred.succeed(f.finish, { stopReason: "stop", text: "Done." });
            yield* Deferred.await(f.settled);
            const turn = yield* onlyTurn();
            assert.equal(turn.reported, false);
            assert.equal(turn.report?.text, resultText);
            assert.ok(turn.replyMessageIds?.length);
            yield* families.deliver(turn);
            assert.equal((yield* onlyTurn()).reported, false);
            assert.equal(f.deliveries.length, 1);
            yield* Deferred.succeed(f.consumeQueued, undefined);
            yield* Deferred.await(f.persisted);
            yield* families.deliver(turn);
            assert.equal((yield* f.storage.state()).turns.length, 0);
            assert.equal(f.deliveries.length, 1);
          }),
        );
      }),
  );

  it.effect.each(["completed", "blocked", "failed"] as const)(
    "ID-free sessions.reply records a %s result and wakes Cake Chat once",
    (outcome) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            const created = yield* createFromChat();
            const entered = yield* Deferred.await(f.entered);
            const options = yield* projectOptions({
              location,
              sessionId: created.sessionId,
              newSession: false,
            });
            assert.equal(entered.sessionId, created.sessionId);
            for (let attempt = 0; attempt < 2; attempt++) {
              const receipt = yield* Effect.promise(() =>
                options.runtime.currentSessionControl!.routeFamilyMessage!(
                  "sessions.reply",
                  { text: resultText, outcome },
                  new AbortController().signal,
                ),
              );
              const decoded = yield* Schema.decodeUnknownEffect(
                Schema.Struct({ status: Schema.String }),
              )(receipt);
              assert.equal(decoded.status, "report-recorded");
            }
            yield* Deferred.succeed(f.finish, {
              stopReason: "stop",
              text: "Final answer also repeats the result, but must not cause a second handoff.",
            });
            yield* Deferred.await(f.settled);
            yield* families.deliver(yield* onlyTurn());
            yield* Deferred.await(f.received);
            assert.ok(
              parseCrossSessionMessage(f.transcript[0] ?? "")?.text.includes(`— ${outcome}`),
            );
            yield* families.deliver(yield* onlyTurn());
            const duplicate = yield* Effect.promise(() =>
              options.runtime.currentSessionControl!.routeFamilyMessage!(
                "sessions.reply",
                { text: resultText, outcome },
                new AbortController().signal,
              ),
            );
            const receipt = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ status: Schema.String }),
            )(duplicate);
            assert.equal(receipt.status, "already-reported");
            assert.equal(f.deliveries.length, 1);
          }),
        );
      }),
  );

  it.effect(
    "an informational send to the originating coordinator shares the automatic result obligation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            const created = yield* createFromChat();
            yield* Deferred.await(f.entered);
            const options = yield* projectOptions({
              location,
              sessionId: created.sessionId,
              newSession: false,
            });
            yield* Effect.promise(() =>
              options.runtime.currentSessionControl!.routeFamilyMessage!(
                "sessions.send",
                { sessionId: CAKE_CHAT_SESSION_ID, text: resultText, expectsResponse: false },
                new AbortController().signal,
              ),
            );
            yield* Deferred.succeed(f.finish, { stopReason: "stop", text: resultText });
            yield* Deferred.await(f.settled);
            const turn = yield* onlyTurn();
            yield* families.deliver(turn);
            yield* Deferred.await(f.received);
            yield* families.deliver(turn);
            assert.equal(f.deliveries.length, 1);
          }),
        );
      }),
  );

  it.effect("explicit coordination can target Cake Chat without a spawning association", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.run(
        Effect.gen(function* () {
          yield* assembleCoordinator();
          const options = yield* projectOptions({
            location,
            sessionId: parentId,
            newSession: false,
          });
          const receipt = yield* Effect.promise(() =>
            options.runtime.currentSessionControl!.routeFamilyMessage!(
              "sessions.send",
              { sessionId: CAKE_CHAT_SESSION_ID, text: resultText, expectsResponse: false },
              new AbortController().signal,
            ),
          );
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ target: Schema.Struct({ kind: Schema.String }) }),
          )(receipt);
          assert.equal(decoded.target.kind, "cake-chat");
          yield* Deferred.await(f.received);
          assert.equal(f.deliveries.length, 1);
          assert.equal((yield* f.storage.state()).spawnedSessions.length, 0);
          assert.equal((yield* f.storage.state()).turns.length, 0);
        }),
      );
    }),
  );

  it.effect("a Project Session send without sessionId reaches Cake Chat", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.run(
        Effect.gen(function* () {
          yield* assembleCoordinator();
          const options = yield* projectOptions({
            location,
            sessionId: parentId,
            newSession: false,
          });
          const receipt = yield* Effect.promise(() =>
            options.runtime.currentSessionControl!.routeFamilyMessage!(
              "sessions.send",
              { text: "Should I drop the legacy column?", resultDelivery: "reply" },
              new AbortController().signal,
            ),
          );
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              ok: Schema.Literal(true),
              command: Schema.Literal("sessions.send"),
              target: Schema.Struct({ kind: Schema.Literal("cake-chat") }),
              targetTitle: Schema.Literal("Cake Chat"),
              delivery: Schema.Literal("prompt"),
              expectsResponse: Schema.Literal(true),
              threadId: Schema.String,
            }),
          )(receipt);
          // Cake Chat is addressed by omission, so the receipt never advertises a session ID.
          assert.ok(!JSON.stringify(decoded.target).includes("sessionId"));
          assert.ok(!JSON.stringify(receipt).includes(CAKE_CHAT_SESSION_ID));
          yield* Deferred.await(f.received);
          assert.deepEqual(f.deliveries, ["prompt"]);
          const message = parseCrossSessionMessage(f.transcript[0] ?? "");
          assert.equal(message?.text, "Should I drop the legacy column?");
          assert.equal(message?.metadata.expectsResponse, true);
          assert.equal(message?.metadata.threadId, decoded.threadId);
          assert.equal(message?.metadata.sender.sessionId, parentId);
          assert.equal(message?.metadata.sender.kind, "project-session");
        }),
      );
    }),
  );

  it.effect(
    "a spawned session's send without sessionId follows sessions.reply's correlation to Cake Chat",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            const created = yield* createFromChat();
            yield* Deferred.await(f.entered);
            const request = yield* onlyTurn();
            const options = yield* projectOptions({
              location,
              sessionId: created.sessionId,
              newSession: false,
            });
            const receipt = yield* Effect.promise(() =>
              options.runtime.currentSessionControl!.routeFamilyMessage!(
                "sessions.send",
                { text: resultText },
                new AbortController().signal,
              ),
            );
            // Like an informational reply, it satisfies the owed result instead of a second report.
            assert.deepEqual(receipt, {
              ok: true,
              command: "sessions.send",
              status: "report-recorded",
              expectsResponse: false,
            });
            yield* Deferred.succeed(f.finish, { stopReason: "stop", text: resultText });
            yield* Deferred.await(f.settled);
            yield* families.deliver(yield* onlyTurn());
            yield* Deferred.await(f.received);
            assert.equal(f.deliveries.length, 1);
            assert.equal(
              parseCrossSessionMessage(f.transcript[0] ?? "")?.metadata.replyToMessageId,
              request.requestMessageId,
            );
          }),
        );
      }),
  );

  it.effect.each([{ sessionId: undefined }, { sessionId: "cake-chat" }] as const)(
    "Cake Chat calling sessions.send with sessionId $sessionId gets an explicit self-message error",
    ({ sessionId }) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            const options = yield* assembleCoordinator();
            const result = yield* Effect.promise(() =>
              options.runtime.globalControl!.invoke(
                {
                  name: "sessions.send",
                  arguments: { text: "Hello", ...(sessionId ? { sessionId } : null) },
                },
                new AbortController().signal,
              ),
            );
            const decoded = yield* Schema.decodeUnknownEffect(
              Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
            )(result);
            assert.match(decoded.error, /Cake Chat cannot message itself/);
            assert.match(decoded.error, /pass the target Project Session's sessionId/);
            assert.deepEqual(f.deliveries, []);
          }),
        );
      }),
  );

  it.effect(
    "failed startup records a factual failure and wakes Cake Chat instead of leaving a phantom success",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture(false, true);
        yield* f.run(
          Effect.gen(function* () {
            const launch = yield* Effect.exit(createFromChat());
            assert.equal(launch._tag, "Failure");
            const turn = yield* onlyTurn();
            assert.equal(turn.outcome, "failed");
            yield* families.deliver(turn);
            yield* Deferred.await(f.received);
            const message = parseCrossSessionMessage(f.transcript[0] ?? "");
            assert.match(message?.text ?? "", /— failed/);
            assert.match(message?.text ?? "", /Provider unavailable during session startup/);
            yield* families.deliver(turn);
            assert.equal(f.deliveries.length, 1);
          }),
        );
      }),
  );

  it.effect.each(["result", "interrupted", "unaccepted", "missing"] as const)(
    "retries %s delivery after startup and recovers a persisted receipt without duplicates",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            const workerId = "979ff4c0-f820-45ab-8b7a-1233c94087a2";
            yield* f.storage.registerSpawn({
              sessionId: workerId,
              projectPath: "/project",
              workingDirectory: "/project",
              requester: { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
              reportDelivered: false,
              handoffSettled: false,
            });
            if (mode !== "unaccepted")
              yield* f.storage.recordTurn({
                sessionId: workerId,
                senderSessionId: CAKE_CHAT_SESSION_ID,
                turnId: "82f2585c-b3cf-4b8f-8a18-4c58b5ca4c4c",
                requestMessageId: workerId,
                threadId: workerId,
                reported: false,
                ...(mode === "result" || mode === "missing"
                  ? { outcome: "complete" as const }
                  : null),
                ...(mode === "result"
                  ? { report: { outcome: "result" as const, text: resultText } }
                  : null),
              });
            yield* families.initialize("/cake/sessions", "/cake/resolved", () =>
              Effect.succeed(false),
            );
            const turn = yield* onlyTurn();
            assert.equal(
              turn.outcome,
              mode === "result" || mode === "missing" ? "complete" : "aborted",
            );
            // A restart cannot invent a coordinator toolset or successful delivery before it is assembled.
            const unavailable = yield* Effect.result(families.deliver(turn));
            assert.equal(unavailable._tag, "Failure");
            assert.equal((yield* f.storage.state()).turns.length, 1);
            yield* assembleCoordinator();
            yield* families.deliver(turn);
            yield* Deferred.await(f.received);
            const message = parseCrossSessionMessage(f.transcript[0] ?? "");
            assert.ok(message);
            assert.equal(message.metadata.expectsResponse, false);
            if (mode === "interrupted" || mode === "unaccepted")
              assert.match(message.text, /canceled or interrupted/);
            else if (mode === "missing")
              assert.match(message.text, /stopped without a substantive result/);
            else assert.ok(message.text.includes(resultText));
            // Simulate a crash before the journal confirmed the recipient's durable transcript receipt.
            yield* Effect.gen(function* () {
              const storage = yield* SessionFamilyStorage;
              const pending = (yield* storage.state()).turns[0];
              assert.ok(pending);
              yield* families.deliver(pending);
              assert.equal((yield* storage.state()).turns.length, 0);
              assert.equal(
                (yield* storage.state()).spawnedSessions[0]?.reportDelivered,
                mode === "result",
              );
              assert.equal((yield* storage.state()).spawnedSessions[0]?.handoffSettled, true);
              yield* families.initialize("/cake/sessions", "/cake/resolved", () =>
                Effect.succeed(false),
              );
              assert.equal((yield* storage.state()).turns.length, 0);
            }).pipe(Effect.provide(familyStorageHarness(f.harness.files).layer));
            assert.equal(f.deliveries.length, 1);
          }),
        );
      }),
  );

  it.effect.each([
    {
      name: "the requester (Cake Chat) stopped it",
      stop: { by: "session", sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
      delivered: undefined,
      status: "stopped",
      summary: "Stopped by Cake Chat",
    },
    {
      name: "the user stopped it",
      stop: { by: "user", reason: "changed plans" },
      delivered: /was stopped by the user \(changed plans\); no result handoff/,
      status: "stopped",
      summary: "Stopped by the user (changed plans)",
    },
    {
      name: "it was interrupted unexpectedly",
      stop: undefined,
      delivered: /canceled or interrupted/,
      status: "interrupted",
      summary: "canceled or interrupted",
    },
  ] as const)("settles an aborted handoff when $name", ({ stop, delivered, status, summary }) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.run(
        Effect.gen(function* () {
          const workerId = "6a4cdbd8-3f5e-4c43-9a55-3c63b8a4e0a1";
          const turnId = "f0e7c2b1-1d2a-4b0e-9a7d-0c0b4b6a9d11";
          yield* f.storage.registerSpawn({
            sessionId: workerId,
            projectPath: "/project",
            workingDirectory: "/project",
            requester: { kind: "cake-chat", sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat" },
            reportDelivered: false,
            handoffSettled: false,
          });
          yield* f.storage.recordTurn({
            sessionId: workerId,
            senderSessionId: CAKE_CHAT_SESSION_ID,
            turnId,
            requestMessageId: workerId,
            threadId: workerId,
            reported: false,
          });
          yield* f.storage.settleTurn(turnId, "aborted", undefined, stop);
          const turn = yield* onlyTurn();
          assert.deepEqual(turn.stop, stop);
          yield* assembleCoordinator();
          yield* families.deliver(turn);
          if (delivered) {
            yield* Deferred.await(f.received);
            assert.match(parseCrossSessionMessage(f.transcript[0] ?? "")?.text ?? "", delivered);
          } else {
            // Cake Chat stopped the session itself; reporting the stop back would be noise.
            assert.deepEqual(f.deliveries, []);
            assert.deepEqual(f.transcript, []);
          }
          const state = yield* f.storage.state();
          if (!delivered) {
            assert.deepEqual(state.turns, []);
            assert.equal(state.spawnedSessions[0]?.handoffSettled, true);
            assert.equal(state.spawnedSessions[0]?.reportDelivered, false);
          }
          assert.equal(state.spawnedSessions[0]?.lastReport?.status, status);
          assert.equal(state.spawnedSessions[0]?.lastReport?.summary, summary);
        }),
      );
    }),
  );

  it.effect.each(["empty", "toolUse", "abort", "providerAbort", "error"] as const)(
    "%s never becomes a successful completion",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            const created = yield* createFromChat();
            yield* Deferred.await(f.entered);
            if (mode === "abort" || mode === "error") {
              const options = yield* projectOptions({
                location,
                sessionId: created.sessionId,
                newSession: false,
              });
              yield* Effect.promise(() =>
                options.runtime.currentSessionControl!.routeFamilyMessage!(
                  "sessions.reply",
                  { text: resultText, outcome: "completed" },
                  new AbortController().signal,
                ),
              );
            }
            if (mode === "abort") {
              const worker = yield* (yield* CakeSessionRuntimes).acquireSession(created.sessionId);
              yield* worker.abort();
            } else {
              yield* Deferred.succeed(f.finish, {
                stopReason:
                  mode === "empty"
                    ? "stop"
                    : mode === "error"
                      ? "error"
                      : mode === "providerAbort"
                        ? "aborted"
                        : "toolUse",
                text: mode === "empty" ? "" : resultText,
                ...(mode === "error" ? { errorMessage: "Provider authorization failed" } : null),
              });
            }
            yield* Deferred.await(f.settled);
            const turn = yield* onlyTurn();
            assert.equal(
              turn.outcome,
              mode === "abort" || mode === "providerAbort"
                ? "aborted"
                : mode === "error"
                  ? "failed"
                  : "complete",
            );
            yield* families.deliver(turn);
            yield* Deferred.await(f.received);
            const message = parseCrossSessionMessage(f.transcript[0] ?? "");
            assert.ok(message);
            assert.doesNotMatch(message.text, /— completed/);
            assert.equal(message.metadata.expectsResponse, false);
            if (mode === "error") assert.match(message.text, /Provider authorization failed/);
            else assert.equal(message.metadata.generatedNotice, true);
            yield* Deferred.succeed(f.finish, { stopReason: "stop", text: resultText });
            yield* families.deliver(yield* onlyTurn());
            assert.equal(f.deliveries.length, 1);
          }),
        );
      }),
  );
  describe("reply obligations belong to one message", () => {
    const coordinatorMessage = (messageId: string, expectsResponse: boolean) =>
      encodeCrossSessionMessage("Also check the admin-web review comments.", {
        version: 1,
        messageId,
        threadId: messageId,
        sequence: 1,
        expectsResponse,
        sender: { sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat", kind: "cake-chat" },
      });

    /** Runs the initial assignment to one delivered report, then returns the worker handle. */
    const reportInitialAssignment = Effect.fn("SpawnedReportingTest.reportInitialAssignment")(
      function* (f: Effect.Success<ReturnType<typeof fixture>>) {
        const created = yield* createFromChat();
        const entered = yield* Deferred.await(f.entered);
        yield* Deferred.succeed(f.finish, { stopReason: "stop", text: resultText });
        assert.equal(yield* Queue.take(f.settledTurns), entered.turnId);
        yield* families.deliver(yield* onlyTurn());
        yield* Deferred.await(f.received);
        // The recipient's transcript proves receipt; the obligation is then cleared.
        yield* families.deliver(yield* onlyTurn());
        const state = yield* f.storage.state();
        assert.deepEqual(state.turns, []);
        assert.equal(state.spawnedSessions[0]?.reportDelivered, true);
        assert.equal(f.deliveries.length, 1);
        // A result is a distinct admission: the coordinator must not settle the worker input again.
        assert.notEqual(
          parseCrossSessionMessage(f.transcript[0] ?? "")?.metadata.messageId,
          entered.turnId,
        );
        return yield* (yield* CakeSessionRuntimes).acquire(
          yield* projectOptions({ location, sessionId: created.sessionId, newSession: false }),
        );
      },
    );

    const deliverAll = Effect.fn("SpawnedReportingTest.deliverAll")(function* () {
      for (const turn of (yield* (yield* SessionFamilyStorage).state()).turns)
        yield* families.deliver(turn);
    });

    it.effect("an obligation is fulfilled once, then user-initiated turns send no notice", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            const worker = yield* reportInitialAssignment(f);
            // The user talks to the session directly: no obligation, no notice.
            const userTurn = yield* worker.prompt("Please also summarize the risky files.");
            assert.equal(yield* Queue.take(f.settledTurns), userTurn);
            assert.deepEqual((yield* f.storage.state()).turns, []);
            yield* deliverAll();
            assert.equal(f.deliveries.length, 1);
            assert.equal(f.transcript.length, 1);
          }),
        );
      }),
    );

    it.effect("a coordinator send with expectsResponse false gets no notice", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            const worker = yield* reportInitialAssignment(f);
            const steer = yield* worker.prompt(
              coordinatorMessage("1f0b1d0e-7f43-4a8e-9a39-6f5f7f3c2b10", false),
            );
            assert.equal(yield* Queue.take(f.settledTurns), steer);
            assert.deepEqual((yield* f.storage.state()).turns, []);
            yield* deliverAll();
            assert.equal(f.deliveries.length, 1);
          }),
        );
      }),
    );

    it.effect("a coordinator send with expectsResponse true gets exactly one result", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            const worker = yield* reportInitialAssignment(f);
            const requestId = "3c1b9c56-6c1e-4d7b-8a53-0b8f1b8a8f21";
            const steer = yield* worker.prompt(coordinatorMessage(requestId, true));
            assert.equal(yield* Queue.take(f.settledTurns), steer);
            const [turn] = (yield* f.storage.state()).turns;
            assert.equal(turn?.requestMessageId, requestId);
            assert.equal(turn?.outcome, "complete");
            assert.equal(turn?.report?.text, resultText);
            yield* deliverAll();
            // Wait for Cake Chat's transcript to persist the answer, then confirm receipt.
            while (f.transcript.length < 2) yield* Effect.yieldNow;
            yield* deliverAll();
            assert.deepEqual((yield* f.storage.state()).turns, []);
            assert.equal(f.deliveries.length, 2);
            const answer = parseCrossSessionMessage(f.transcript[1] ?? "");
            assert.ok(answer?.text.includes(resultText));
            assert.equal(answer?.metadata.replyToMessageId, requestId);
            assert.equal(answer?.metadata.expectsResponse, false);
            // Neither message reports a stopped or failed outcome for the same work.
            assert.ok(!f.transcript.some((text) => /stopped without|canceled|failed/.test(text)));
          }),
        );
      }),
    );

    it.effect("Ignore creation emits neither a notification nor a parent turn", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            const options = yield* assembleCoordinator();
            yield* Effect.promise(() =>
              options.runtime.globalControl!.invoke(
                {
                  name: "sessions.create",
                  arguments: { workspacePath: "/project", ...createArgs, resultDelivery: "ignore" },
                },
                new AbortController().signal,
              ),
            );
            const entered = yield* Deferred.await(f.entered);
            assert.equal(parseCrossSessionMessage(entered.text)?.metadata.expectsResponse, false);
            yield* Deferred.succeed(f.finish, { stopReason: "stop", text: resultText });
            assert.equal(yield* Queue.take(f.settledTurns), entered.turnId);
            const state = yield* f.storage.state();
            assert.deepEqual(state.turns, []);
            assert.equal(state.spawnedSessions[0]?.handoffSettled, true);
            // A restart cannot invent an "interrupted" notice for work that owed nothing.
            yield* families.initialize("/cake/sessions", "/cake/resolved", () =>
              Effect.succeed(false),
            );
            assert.deepEqual((yield* f.storage.state()).turns, []);
            assert.equal(f.deliveries.length, 0);
          }),
        );
      }),
    );
  });

  describe("Cake Chat report policy", () => {
    const userMessage = (text: string) =>
      sessionChats
        .deliver(
          {
            sessionId: CAKE_CHAT_SESSION_ID,
            text,
            attachments: [],
            renderUserMessageAsMarkdown: false,
          },
          "prompt",
        )
        .pipe(Effect.provide(Layer.mock(TaskInputStorage, {})));

    it.effect(
      "digest results never start a Cake Chat turn and ride along with the next user message",
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.run(
            Effect.gen(function* () {
              const created = yield* createFromChat([], null);
              const entered = yield* Deferred.await(f.entered);
              const assignment = parseCrossSessionMessage(entered.text);
              assert.equal(assignment?.metadata.expectsResponse, true);
              assert.equal(assignment?.metadata.resultDelivery, "notification");
              yield* Deferred.succeed(f.finish, {
                stopReason: "stop",
                text: `## Summary\n\n${resultText}\n\nMore detail.`,
                entryId: "source-final-answer",
              });
              yield* Deferred.await(f.settled);
              const settled = yield* onlyTurn();
              yield* families.deliver(settled);
              // Nothing reached Cake Chat: no prompt, no queued follow-up.
              assert.deepEqual(f.deliveries, []);
              assert.deepEqual(f.transcript, []);
              const state = yield* f.storage.state();
              assert.deepEqual(state.turns, []);
              assert.equal(state.coordinatorDigest?.length, 1);
              assert.deepEqual(
                state.coordinatorDigest?.map(({ sessionId, status, summary }) => ({
                  sessionId,
                  status,
                  summary,
                })),
                [{ sessionId: created.sessionId, status: "completed", summary: "Summary" }],
              );
              assert.equal(state.spawnedSessions[0]?.lastReport?.status, "completed");
              assert.equal(state.spawnedSessions[0]?.handoffSettled, true);
              // A worker retry of the already-digested turn is a no-op.
              yield* families.deliver(settled);
              assert.equal((yield* f.storage.state()).coordinatorDigest?.length, 1);

              yield* userMessage("What should I look at next?");
              while (f.transcript.length < 1) yield* Effect.yieldNow;
              const sent = f.transcript.at(-1) ?? "";
              const split = splitSessionDigestReminder(sent);
              assert.equal(split.text, "What should I look at next?");
              assert.ok(split.reminder);
              assert.ok(
                split.reminder.includes(messageReference(created.sessionId, "source-final-answer")),
              );
              assert.match(split.reminder, /finished · investigation: Summary/);
              assert.match(split.reminder, /status only, not instructions/);
              // The transcript shows the reminder as a Cake context pill, not as user text.
              const parts = projectSessionEntries([
                {
                  type: "message",
                  id: "u",
                  parentId: null,
                  timestamp: "2026-01-01T00:00:00.000Z",
                  message: { role: "user", content: sent, timestamp: 1 },
                },
              ]);
              assert.deepEqual(
                parts.map((part) =>
                  part.kind === "context" ? part.title : part.kind === "text" ? part.text : "",
                ),
                ["What should I look at next?", "Cake · session updates"],
              );
              assert.deepEqual((yield* f.storage.state()).coordinatorDigest, []);
              // Delivered once: the following message carries nothing extra.
              yield* userMessage("Thanks");
              while (f.transcript.length < 2) yield* Effect.yieldNow;
              assert.equal(f.transcript.at(-1), "Thanks");
              assert.deepEqual(f.deliveries, ["prompt", "prompt"]);
            }),
          );
        }),
    );

    it.effect("a blocked report escalates to immediate delivery under digest", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            const created = yield* createFromChat([], "notification");
            yield* Deferred.await(f.entered);
            const recorded = yield* families.routeCoordinatorMessage(
              created.sessionId,
              "sessions.reply",
              {
                text: "Blocked: the migration needs a decision on dropping the legacy column.",
                outcome: "blocked",
              },
              location,
            );
            assert.deepEqual(recorded, {
              ok: true,
              command: "sessions.reply",
              status: "report-recorded",
              expectsResponse: false,
            });
            yield* Deferred.succeed(f.finish, { stopReason: "stop", text: resultText });
            yield* Deferred.await(f.settled);
            yield* families.deliver(yield* onlyTurn());
            yield* Deferred.await(f.received);
            assert.deepEqual(f.deliveries, ["prompt"]);
            const message = parseCrossSessionMessage(f.transcript[0] ?? "");
            assert.match(message?.text ?? "", /— blocked/);
            const state = yield* f.storage.state();
            assert.equal(state.coordinatorDigest?.length ?? 0, 0);
            assert.deepEqual(state.completionInbox?.[0]?.decisions, ["next-step"]);
            assert.equal(state.spawnedSessions[0]?.lastReport?.status, "blocked");
          }),
        );
      }),
    );

    it.effect("failures and interruptions are digested, not delivered", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            const created = yield* createFromChat([], null);
            yield* Deferred.await(f.entered);
            yield* Deferred.succeed(f.finish, {
              stopReason: "error",
              text: "",
              errorMessage: "Provider rejected the request",
            });
            yield* Deferred.await(f.settled);
            yield* families.deliver(yield* onlyTurn());
            assert.deepEqual(f.deliveries, []);
            const [item] = (yield* f.storage.state()).coordinatorDigest ?? [];
            assert.equal(item?.sessionId, created.sessionId);
            assert.equal(item?.status, "failed");
            assert.match(item?.summary ?? "", /Provider rejected/);
          }),
        );
      }),
    );

    it.effect("work interrupted by a restart is digested under the launch's policy", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            yield* assembleCoordinator();
            const sessionId = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
            yield* f.storage.registerSpawn({
              sessionId,
              projectPath: "/project",
              workingDirectory: "/project",
              requester: { sessionId: CAKE_CHAT_SESSION_ID, kind: "cake-chat", title: "Cake Chat" },
              reportDelivered: false,
              handoffSettled: false,
              resultDelivery: "notification",
            });
            yield* families.initialize("/cake/sessions", "/cake/resolved", () =>
              Effect.succeed(false),
            );
            const turn = yield* onlyTurn();
            assert.equal(turn.resultDelivery, "notification");
            yield* families.deliver(turn);
            assert.deepEqual(f.deliveries, []);
            const [item] = (yield* f.storage.state()).coordinatorDigest ?? [];
            assert.equal(item?.status, "interrupted");
            assert.equal(item?.summary, "canceled or interrupted");
          }),
        );
      }),
    );

    it.effect("interrupt results wait while the user is composing, then arrive", () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.run(
          Effect.gen(function* () {
            const presence = yield* CakeChatComposerPresence;
            yield* createFromChat([], "reply");
            yield* Deferred.await(f.entered);
            yield* Deferred.succeed(f.finish, { stopReason: "stop", text: resultText });
            yield* Deferred.await(f.settled);
            yield* presence.setComposing(true);
            yield* families.deliver(yield* onlyTurn());
            assert.deepEqual(f.deliveries, []);
            assert.equal((yield* onlyTurn()).reported, false);
            // Unsent text holds the report only for a bounded time.
            yield* TestClock.adjust(CAKE_CHAT_COMPOSING_HOLD_MS);
            assert.equal(yield* presence.holdsInterrupts(), false);
            yield* presence.setComposing(true);
            yield* families.deliver(yield* onlyTurn());
            assert.deepEqual(f.deliveries, []);
            yield* presence.setComposing(false);
            yield* families.deliver(yield* onlyTurn());
            yield* Deferred.await(f.received);
            assert.deepEqual(f.deliveries, ["prompt"]);
          }).pipe(Effect.provide(CakeChatComposerPresence.layer)),
        );
      }),
    );

    for (const coordinator of [CAKE_CHAT_SESSION_ID, projectChatSessionId("/project")])
      it.effect.each(["reply", "notification", "ignore"] as const)(
        `a correlated request from ${coordinator} to an existing session obeys %s without a manual completion report`,
        (resultDelivery) =>
          Effect.gen(function* () {
            const f = yield* fixture();
            yield* f.run(
              Effect.gen(function* () {
                yield* assembleCoordinator(coordinator);
                const sessionId = "7d0f1e57-1b8e-4c31-9f2a-2f7a3e0c9b11";
                const worker = yield* (yield* CakeSessionRuntimes).acquire(
                  yield* projectOptions({ location, sessionId, newSession: false }),
                );
                const messageId = "0b9c2f7e-4d1a-4c6b-8f3e-5a2d9c1b7e40";
                yield* worker
                  .prompt(
                    encodeCrossSessionMessage("Check the flaky test.", {
                      version: 1,
                      messageId,
                      threadId: messageId,
                      sequence: 1,
                      expectsResponse: resultDelivery !== "ignore",
                      resultDelivery,
                      sender: { sessionId: coordinator, title: "Coordinator", kind: "cake-chat" },
                    }),
                  )
                  .pipe(Effect.forkScoped);
                yield* Deferred.await(f.entered);
                assert.equal(
                  (yield* f.storage.state()).turns.length,
                  resultDelivery === "ignore" ? 0 : 1,
                );
                yield* Deferred.succeed(f.finish, {
                  stopReason: "stop",
                  text: resultText,
                  entryId: "exact-existing-session-result",
                });
                yield* Deferred.await(f.settled);
                for (const turn of (yield* f.storage.state()).turns) yield* families.deliver(turn);
                if (resultDelivery === "reply") {
                  yield* Deferred.await(f.received);
                  const text = f.chatTranscripts.get(coordinator)?.[0] ?? "";
                  assert.ok(
                    text.includes(messageReference(sessionId, "exact-existing-session-result")),
                  );
                  assert.equal(
                    parseCrossSessionMessage(text)?.metadata.replyToMessageId,
                    messageId,
                  );
                }
                assert.deepEqual(f.deliveries, resultDelivery === "reply" ? ["prompt"] : []);
                const inbox = (yield* f.storage.state()).coordinatorDigest ?? [];
                assert.equal(inbox.length, resultDelivery === "notification" ? 1 : 0);
                if (resultDelivery === "notification") {
                  assert.equal(inbox[0]?.coordinatorSessionId, coordinator);
                  assert.equal(
                    inbox[0]?.resultMessageRef,
                    messageReference(sessionId, "exact-existing-session-result"),
                  );
                }
                assert.equal((yield* f.storage.state()).spawnedSessions.length, 0);
              }),
            );
          }),
      );
  });
});
