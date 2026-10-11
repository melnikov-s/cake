import assert from "node:assert/strict";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { describe } from "vitest";
import * as families from "../../../src/domain/session-families/sessionFamilies";
import { acquireOptions as projectOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { acquireOptions as chatOptions } from "../../../src/domain/cake-chats/cakeChatRuntime";
import { createPrompted } from "../../../src/domain/project-sessions/projectSessionCreation";
import { CAKE_CHAT_SESSION_ID } from "../../../src/ipc/cake-chat-data";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import type { Attachment } from "../../../src/ipc/session-contract";
import type { PiTurnResult } from "../../../src/contracts/pi/turn-result-data";
import { parseCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLayer,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { PiModels } from "../../../src/services/pi/PiModels";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { fakeRuntime, snapshot } from "../helpers/piRuntimeFixture";
import { projectSessionEntries } from "../../../src/services/pi/runtime/session-projection";
import { TurnCanceledError } from "../../../src/services/pi/runtime/RuntimeTurnCompletion";
import * as sessionChats from "../../../src/domain/conversations/sessionChats";

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
  const received = yield* Deferred.make<void>();
  const persisted = yield* Deferred.make<void>();
  const executing = new Map<string, string[]>();
  const materialized = new Set<string>([parentId, CAKE_CHAT_SESSION_ID]);
  const consumeQueued = yield* Deferred.make<void>();
  const transcript: string[] = [];
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
      locate: (id) => Effect.succeed(materialized.has(id) ? ("active" as const) : undefined),
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
              return {
                ...fakeRuntime(options, () => undefined),
                sessionId: options.sessionId ?? "unexpected",
                sessionFile: `${options.sessionDir}/${options.sessionId}.jsonl`,
                executingTurnIds: () => executing.get(options.sessionId ?? "") ?? [],
                snapshot: async () => ({
                  ...snapshot,
                  sessionId: options.sessionId ?? "unexpected",
                  streaming: busy,
                  parts: projectSessionEntries(
                    transcript.map((content, index) => ({
                      type: "message",
                      id: String(index),
                      parentId: null,
                      timestamp: "2026-01-01T00:00:00.000Z",
                      message: { role: "user", content, timestamp: index },
                    })),
                  ),
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
                        options.sessionId === CAKE_CHAT_SESSION_ID ||
                        options.sessionId === parentId
                      ) {
                        deliveries.push(delivery);
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
                        transcript.push(text);
                        yield* Deferred.succeed(persisted, undefined);
                        yield* Deferred.succeed(received, undefined);
                      } else {
                        submittedAttachments.set(options.sessionId ?? "", _attachments);
                        executing.set(options.sessionId ?? "", [turnId]);
                        yield* Deferred.succeed(entered, {
                          sessionId: options.sessionId ?? "unexpected",
                          turnId,
                          text,
                        });
                        const result = yield* Deferred.await(finish);
                        options.onTurnResult?.(turnId, result);
                        executing.delete(options.sessionId ?? "");
                      }
                    }),
                  ),
              };
            }),
    }),
  );
  const context = yield* Layer.build(environment);
  const storage = yield* SessionFamilyStorage.pipe(Effect.provide(context));
  const observedStorage = {
    ...storage,
    settleTurn: (...args: Parameters<typeof storage.settleTurn>) =>
      storage.settleTurn(...args).pipe(Effect.andThen(Deferred.succeed(settled, undefined))),
  };
  return {
    context,
    storage: observedStorage,
    harness,
    entered,
    finish,
    settled,
    received,
    persisted,
    consumeQueued,
    transcript,
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

const assembleCoordinator = Effect.fn("SpawnedReportingTest.assembleCoordinator")(function* () {
  const sessions = yield* CakeSessionRuntimes;
  const options = yield* chatOptions({
    configuration: {
      location: {
        workingDirectory: "/home",
        sessionDirectory: "/chat",
        resolvedSessionDirectory: "/chat-resolved",
      },
      agentDirectory: "/cake",
    },
    target: { sessionId: CAKE_CHAT_SESSION_ID, tools: [] },
    newSession: false,
  });
  yield* sessions.acquire(options);
  return options;
});

const createFromChat = Effect.fn("SpawnedReportingTest.createFromChat")(function* (
  inputRefs: readonly string[] = [],
) {
  const options = yield* assembleCoordinator();
  assert.ok(options.runtime.globalControl);
  const result = yield* Effect.promise(() =>
    options.runtime.globalControl!.invoke(
      {
        name: "sessions.create",
        arguments: { workspacePath: "/project", ...createArgs, inputRefs: [...inputRefs] },
      },
      new AbortController().signal,
    ),
  );
  return yield* Schema.decodeUnknownEffect(Schema.Struct({ sessionId: Schema.String }))(result);
});

const onlyTurn = Effect.fn("SpawnedReportingTest.onlyTurn")(function* () {
  const state = yield* (yield* SessionFamilyStorage).state();
  const turns = state.turns.filter((turn) => turn.completionContract);
  assert.equal(turns.length, 1);
  const turn = turns[0];
  assert.ok(turn);
  return turn;
});

describe("automatic spawned-session reporting", () => {
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
                  expectsResponse: true,
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
            if (destination === "cake-chat") yield* createFromChat();
            else {
              const root = yield* projectOptions({ location, sessionId, newSession: false });
              yield* (yield* CakeSessionRuntimes).acquire(root);
              yield* Effect.promise(() =>
                root.runtime.currentSessionControl!.createChildSession!(
                  {
                    requestId: "cancel-child",
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
            assert.equal(state.turns[0]?.completionContract, true);
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
          assert.equal((yield* onlyTurn()).completionContract, true);
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
            assert.equal(
              (yield* f.storage.state()).turns.filter((item) => item.completionContract).length,
              0,
            );
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
                completionContract: true,
                reported: false,
                expectsResponse: true,
                ...(mode === "result" || mode === "missing"
                  ? { outcome: "complete" as const }
                  : null),
                ...(mode === "result"
                  ? { report: { outcome: "result" as const, text: resultText } }
                  : null),
              });
            yield* families.initialize("/cake/sessions", "/cake/resolved");
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
              yield* families.initialize("/cake/sessions", "/cake/resolved");
              assert.equal((yield* storage.state()).turns.length, 0);
            }).pipe(Effect.provide(familyStorageHarness(f.harness.files).layer));
            assert.equal(f.deliveries.length, 1);
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
});
