import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Layer, Stream } from "effect";
import { describe } from "vitest";
import * as boards from "../../../src/domain/artifacts/messageBoards";
import * as deliveries from "../../../src/domain/session-families/workboardDeliveries";
import * as chats from "../../../src/domain/conversations/sessionChats";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import {
  CakeSessionRuntimes,
  PiSessionError,
  makeCakeSessionRuntimesLayer,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import {
  RuntimeRecoveryStorage,
  type RuntimeRecoveryRecord,
} from "../../../src/services/storage/RuntimeRecoveryStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { PiModels } from "../../../src/services/pi/PiModels";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { messageBoardHarness } from "../helpers/messageBoardHarness";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";
import {
  fakeRuntime,
  snapshot,
  makeRuntimeRecoveryStorageTestLayer,
} from "../helpers/piRuntimeFixture";

const fixture = Effect.fn("BoardDeliveryTest.fixture")(function* (
  settings: {
    busy?: boolean;
    initialAssignment?: boolean;
    failFirstAcquire?: boolean;
    familyFiles?: Map<string, string>;
    boardFiles?: Map<string, string>;
    records?: ReadonlyArray<RuntimeRecoveryRecord>;
    resolved?: boolean;
  } = {},
) {
  const family = familyStorageHarness(settings.familyFiles);
  const board = messageBoardHarness(settings.boardFiles);
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const lanes: string[] = [];
  const recipients: string[] = [];
  const admitted: Array<{
    text: string;
    internal: RuntimeRecoveryRecord["inputs"][number]["internal"];
  }> = [];
  let busy = settings.busy ?? false;
  let failAcquire = settings.failFirstAcquire ?? false;
  const core = yield* Layer.build(
    Layer.mergeAll(
      WorkflowTestLive,
      makeHeadlessProjectSessionRuntimeMechanismTestLayer(),
      family.layer,
      board.layer,
      SessionCatalogChanges.layer,
      Layer.mock(ApplicationState, {
        snapshot: () => defaultApplicationState(),
        current: () => Effect.succeed(defaultApplicationState()),
      }),
      Layer.mock(PiModels, { resolve: (model) => Effect.succeed(model) }),
      Layer.mock(ManagedWorktrees, {
        records: () => Effect.succeed([]),
        awaitSetup: () => Effect.void,
      }),
      Layer.mock(SessionArchiveStorage, {
        locate: () =>
          Effect.succeed(settings.resolved ? ("resolved" as const) : ("active" as const)),
        resolvedProjectEntry: () => Effect.succeed(undefined),
        resolvedProjects: () => Stream.empty,
      }),
      makeCakeSessionRuntimesLayer({
        sessionIds: () => Stream.empty,
        catalog: () => Stream.empty,
        catalogEntry: () => Effect.succeed(undefined),
        inspect: () => Effect.succeed(undefined),
        changelog: () => Effect.succeed(""),
        createRuntime: (setup) =>
          Effect.suspend(() => {
            if (failAcquire) {
              failAcquire = false;
              return Effect.fail(
                new PiSessionError({ operation: "acquire", message: "Temporary failure" }),
              );
            }
            return Effect.succeed({
              ...fakeRuntime(setup, () => undefined),
              sessionId: setup.sessionId ?? "child",
              get streaming() {
                return busy;
              },
              snapshot: async () => ({
                ...snapshot,
                sessionId: setup.sessionId ?? "child",
                streaming: busy,
              }),
              prompt: async (
                text,
                lane,
                _attachments,
                _markdown,
                _turnId,
                _presentation,
                _title,
                _response,
                internal,
              ) => {
                admitted.push({ text, internal });
                lanes.push(lane);
                recipients.push(setup.sessionId ?? "missing");
                await Effect.runPromise(
                  Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                );
              },
            });
          }),
      }).pipe(Layer.provideMerge(makeRuntimeRecoveryStorageTestLayer(settings.records))),
    ),
  );
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(core));
  yield* provide(
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      if (!(yield* storage.familyForMember("parent")))
        yield* storage.addChild({
          familyId: "family",
          parentSessionId: "parent",
          parentWorkingDirectory: "/project",
          childSessionId: "child",
          childWorkingDirectory: "/project",
          requestId: "child",
          projectPath: "/project",
          createdAt: "2026-01-01",
          resultDelivery: "ignore",
          ...(settings.initialAssignment ? { assignmentTopic: "child-child" } : null),
        });
      const current = yield* storage.familyForMember("parent");
      assert.ok(current);
      yield* boards.ensureBoard(current);
    }),
  );
  const post = (requestId = "assignment-1") =>
    provide(
      boards.append("parent", {
        requestId,
        audience: ["child"],
        description: "Begin work",
        body: "Implement the agreed slice; report on this board.",
      }),
    );
  const state = () => provide(Context.get(core, SessionFamilyStorage).state());
  return {
    provide,
    post,
    state,
    lanes,
    recipients,
    admitted,
    setBusy: (value: boolean) => {
      busy = value;
    },
    started,
    release,
    familyFiles: family.files,
    boardFiles: board.files,
  };
});

describe("default board-driven execution", () => {
  it.effect(
    "preserves preexisting stopped journals across restart and future user resumption",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({
          records: [
            {
              sessionId: "child",
              workingDirectory: "/project",
              sessionDirectory: "/cake/sessions",
              profile: "ProjectSession",
              transcriptPersisted: true,
              inputs: [],
              state: "stopped",
            },
          ],
        });
        yield* f.post();
        yield* f.provide(deliveries.runPass());
        assert.deepEqual(f.recipients, []);
        assert.equal((yield* f.state()).boardDeliveries?.[0]?.status, "canceled");
        assert.deepEqual((yield* f.state()).boardDeliveryPaused, ["child"]);
        yield* f.provide(deliveries.resumeAfterUserInput("child"));
        yield* f.provide(deliveries.runPass());
        assert.deepEqual(f.recipients, []);
      }).pipe(Effect.scoped),
  );
  it.effect(
    "rejects changed correction metadata on a retried append instead of silently dropping it",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.post("unchanged");
        const error = yield* Effect.flip(
          f.provide(
            boards.append("parent", {
              requestId: "unchanged",
              audience: ["child"],
              description: "Begin work",
              body: "Implement the agreed slice; report on this board.",
              topic: "new-topic",
            }),
          ),
        );
        assert.match(error.message, /requestId already belongs/);
      }).pipe(Effect.scoped),
  );
  it.effect("leaves first child admission to create-child but delivers later ordinary posts", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ initialAssignment: true });
      yield* f.provide(
        boards.append("parent", {
          audience: ["child"],
          topic: "child-child",
          description: "Initial assignment",
          body: "Persisted before first admission",
        }),
      );
      yield* f.provide(deliveries.runPass());
      assert.deepEqual((yield* f.state()).boardDeliveries ?? [], []);
      assert.deepEqual(f.recipients, []);
      yield* f.post();
      yield* f.provide(deliveries.runPass());
      yield* Deferred.await(f.started);
      assert.deepEqual(f.recipients, ["child"]);
      assert.deepEqual((yield* f.state()).boardDeliveries?.[0]?.sequences, [2]);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "recovers a failed runtime acquisition from the persisted batch without reposting",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ failFirstAcquire: true });
        yield* f.post();
        yield* f.provide(deliveries.runPass());
        const pending = (yield* f.state()).boardDeliveries?.[0];
        assert.equal(pending?.status, "pending");
        assert.ok(pending?.issue);
        assert.deepEqual(f.recipients, []);
        yield* f.provide(deliveries.runPass());
        yield* Deferred.await(f.started);
        assert.equal((yield* f.state()).boardDeliveries?.[0]?.turnId, pending?.turnId);
        assert.deepEqual(f.recipients, ["child"]);
      }).pipe(Effect.scoped),
  );
  it.effect("bounds active batches to twenty and carries newer posts into the next batch", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ busy: true });
      for (let index = 0; index < 25; index++) yield* f.post(`post-${index}`);
      yield* f.provide(deliveries.runPass());
      const batch = (yield* f.state()).boardDeliveries?.[0];
      assert.equal(batch?.sequences.length, 20);
      assert.equal(batch?.through, 20);
      yield* f.post("newer");
      yield* f.provide(
        boards.recordIntake("child", batch!.boardId, batch!.sequences, "notifiedAt"),
      );
      yield* f.provide(deliveries.runPass());
      yield* f.provide(deliveries.runPass());
      const records = (yield* f.state()).boardDeliveries ?? [];
      assert.equal(records.length, 2);
      assert.equal(records[0]?.status, "notified");
      assert.deepEqual(records[1]?.sequences, [21, 22, 23, 24, 25, 26]);
      assert.deepEqual(f.recipients, []);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "coalesces ordinary addressed posts into one durable idle wake and deduplicates append retries",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const a = yield* f.post("a");
        yield* f.post("b");
        yield* f.post("c");
        assert.deepEqual(a.scheduledRecipients, ["child"]);
        yield* f.provide(deliveries.runPass());
        const state = yield* f.state();
        assert.equal(
          state.boardDeliveries?.[0]?.status,
          "admitted",
          JSON.stringify(state.boardDeliveries),
        );
        yield* Deferred.await(f.started);
        assert.deepEqual(f.lanes, ["follow-up"]);
        assert.deepEqual(state.boardDeliveries?.[0]?.sequences, [1, 2, 3]);
        const origin = {
          _tag: "WorkboardDelivery",
          boardId: state.boardDeliveries?.[0]?.boardId,
          sequences: [1, 2, 3],
        };
        assert.deepEqual(f.admitted[0]?.internal, origin);
        assert.match(f.admitted[0]?.text ?? "", /<system-reminder>\nWorkboard delivery/);
        const journal = yield* f.provide(
          Effect.gen(function* () {
            return yield* (yield* RuntimeRecoveryStorage).get("child");
          }),
        );
        assert.deepEqual(journal?.inputs[0]?.internal, origin);
        assert.equal(journal?.inputs[0]?.turnId, state.boardDeliveries?.[0]?.turnId);
        const again = yield* f.post("a");
        assert.equal(again.entry.sequence, 1);
        yield* f.provide(deliveries.runPass());
        assert.equal(f.lanes.length, 1);
        const receipts = yield* f.provide(boards.entryReceipts("parent", 1));
        assert.equal(receipts.deliveries?.[0]?.status, "admitted");
        assert.equal(
          receipts.receipts.find((item) => item.sessionId === "child")?.readAt,
          undefined,
        );
      }),
  );

  it.effect(
    "routes every descendant post to the unique family root and explicit recipients once, never the author",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.provide(
          Effect.gen(function* () {
            yield* (yield* SessionFamilyStorage).addChild({
              familyId: "ignored",
              parentSessionId: "child",
              parentWorkingDirectory: "/project",
              childSessionId: "grandchild",
              childWorkingDirectory: "/project",
              requestId: "grandchild",
              projectPath: "/project",
              createdAt: "2026-01-01",
            });
            yield* boards.append("grandchild", {
              audience: ["child", "parent"],
              description: "Update",
              body: "Evidence",
            });
            yield* boards.append("child", {
              audience: "workgroup",
              description: "Result",
              body: "Evidence",
              event: "completion",
            });
          }),
        );
        yield* f.provide(deliveries.runPass());
        assert.deepEqual(f.recipients.sort(), ["child", "parent"]);
        const records = (yield* f.state()).boardDeliveries;
        assert.deepEqual(
          records?.find((item) => item.recipientSessionId === "parent")?.sequences,
          [1, 2],
        );
        assert.deepEqual(
          records?.find((item) => item.recipientSessionId === "child")?.sequences,
          [1],
        );
        const rootInbox = yield* f.provide(boards.readNew("parent", {}, true));
        assert.deepEqual(
          rootInbox.entries.map((entry) => entry.sequence),
          [1, 2],
        );
      }),
  );

  it.effect(
    "active recipients wait for a non-disruptive model boundary; confirmed inbox intake suppresses an extra wake",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ busy: true });
        yield* f.post("a");
        yield* f.post("b");
        yield* f.provide(deliveries.runPass());
        assert.deepEqual(f.lanes, []);
        assert.match(
          (yield* f.state()).boardDeliveries?.[0]?.issue ?? "",
          /before_agent_start\/turn_end/,
        );
        const inbox = yield* f.provide(boards.readNew("child", {}, true));
        assert.deepEqual(
          inbox.entries.map((entry) => entry.sequence),
          [1, 2],
        );
        // External boundary: observeMessageBoardRequests confirms these only after the
        // real outgoing model stream receives them (covered by message-board-runtime).
        yield* f.provide(boards.recordIntake("child", inbox.boardId, [1, 2], "notifiedAt"));
        yield* f.provide(deliveries.runPass());
        assert.equal((yield* f.state()).boardDeliveries?.[0]?.status, "notified");
        f.setBusy(false);
        yield* f.provide(deliveries.runPass());
        assert.deepEqual(f.lanes, []);
      }),
  );

  it.effect(
    "if no next request consumes a staged reminder, becoming idle admits one durable fallback",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ busy: true });
        yield* f.post();
        yield* f.provide(deliveries.runPass());
        assert.deepEqual(f.lanes, []);
        f.setBusy(false);
        yield* f.provide(deliveries.runPass());
        yield* Deferred.await(f.started);
        yield* f.provide(deliveries.runPass());
        assert.equal(f.lanes.length, 1);
      }),
  );

  it.effect("board/outbox crash gaps and restart keep one stable admitted batch", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.post();
      assert.equal((yield* f.state()).boardDeliveries?.length ?? 0, 0);
      yield* f.provide(deliveries.runPass());
      yield* Deferred.await(f.started);
      const records = yield* f.provide(
        Effect.gen(function* () {
          return yield* (yield* RuntimeRecoveryStorage).list();
        }),
      );
      const restarted = yield* fixture({
        familyFiles: f.familyFiles,
        boardFiles: f.boardFiles,
        records,
      });
      yield* restarted.provide(deliveries.runPass());
      assert.deepEqual(restarted.lanes, []);
      assert.equal(
        (yield* restarted.state()).boardDeliveries?.[0]?.turnId,
        (yield* f.state()).boardDeliveries?.[0]?.turnId,
      );
    }),
  );

  it.effect(
    "self posts and untargeted non-root members do not wake; broadcasts notify only the root",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.provide(
          boards.append("parent", {
            audience: ["parent"],
            description: "Own note",
            body: "No echo",
          }),
        );
        yield* f.provide(
          boards.append("parent", {
            audience: "workgroup",
            description: "Broadcast",
            body: "No herd",
          }),
        );
        yield* f.provide(deliveries.runPass());
        assert.deepEqual(f.lanes, []);
        yield* f.provide(
          boards.append("child", {
            audience: ["child"],
            description: "Self note",
            body: "Root still sees all",
          }),
        );
        yield* f.provide(deliveries.runPass());
        assert.deepEqual(f.recipients, ["parent"]);
      }),
  );

  it.effect(
    "explicit stop remains authoritative; new user resumption permits future posts, not old canceled batches",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.post();
        yield* f.provide(
          Effect.gen(function* () {
            yield* (yield* CakeSessionRuntimes).acquire(
              yield* acquireOptions({
                sessionId: "child",
                newSession: false,
                location: {
                  projectPath: "/project",
                  projectName: "Project",
                  workingDirectory: "/project",
                  sessionDirectory: "/cake/sessions",
                  resolvedSessionDirectory: "/cake/resolved",
                },
              }),
            );
            yield* chats.abort({ sessionId: "child", stop: { by: "user" } });
          }),
        );
        yield* f.post("after-stop");
        yield* f.provide(deliveries.runPass());
        assert.deepEqual(f.lanes, []);
        assert.ok((yield* f.state()).boardDeliveries?.every((item) => item.status === "canceled"));
        yield* f.provide(deliveries.resumeAfterUserInput("child"));
        yield* f.provide(deliveries.runPass());
        assert.deepEqual(f.lanes, []);
        assert.deepEqual((yield* f.provide(boards.readNew("child", {}, true))).entries, []);
        assert.equal((yield* f.provide(boards.readNew("child"))).entries.length, 2);
        yield* f.post("future");
        yield* f.provide(deliveries.runPass());
        yield* Deferred.await(f.started);
        assert.equal(f.lanes.length, 1);
      }),
  );

  it.effect.each(["canceled", "resolved"] as const)("never resurrects %s board batches", (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture({ resolved: mode === "resolved", busy: true });
      yield* f.post();
      yield* f.provide(deliveries.runPass());
      if (mode === "canceled")
        yield* f.provide(
          Effect.gen(function* () {
            const delivery = (yield* (yield* SessionFamilyStorage).state()).boardDeliveries?.[0];
            assert.ok(delivery);
            yield* (yield* RuntimeRecoveryStorage).update({
              sessionId: "child",
              workingDirectory: "/project",
              sessionDirectory: "/cake/sessions",
              profile: "ProjectSession",
              transcriptPersisted: true,
              inputs: [],
              state: "complete",
              canceledInputIds: [delivery.turnId],
            });
          }),
        );
      f.setBusy(false);
      yield* f.provide(deliveries.runPass());
      yield* f.provide(deliveries.runPass());
      assert.deepEqual(f.lanes, []);
      assert.equal((yield* f.state()).boardDeliveries?.[0]?.status, "canceled");
    }),
  );
});
