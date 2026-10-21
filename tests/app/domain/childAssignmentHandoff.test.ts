import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Layer, Stream, Schema, Option, Fiber } from "effect";
import { describe } from "vitest";
import { createChild, initialize } from "../../../src/domain/session-families/sessionFamilies";
import * as boards from "../../../src/domain/artifacts/messageBoards";
import { MessageBoardError } from "../../../src/contracts/artifacts/message-board";
import { parseCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import { createSessionFamilyOperations } from "../../../src/domain/session-families/cake-session-family-operations";
import { PiModels } from "../../../src/services/pi/PiModels";
import { makeCakeSessionRuntimesLayer } from "../../../src/services/pi/CakeSessionRuntimes";
import { MessageBoardStorage } from "../../../src/services/storage/MessageBoardStorage";
import {
  RuntimeRecoveryStorage,
  RuntimeRecoveryStorageError,
  type RuntimeRecoveryRecord,
} from "../../../src/services/storage/RuntimeRecoveryStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { projectTodoLayer } from "../helpers/projectTodoHarness";
import * as todos from "../../../src/domain/projects/projectTodos";
import { messageBoardHarness } from "../helpers/messageBoardHarness";
import {
  fakeRuntime,
  options,
  makeRuntimeRecoveryStorageTestLayer,
} from "../helpers/piRuntimeFixture";

const location = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  sessionDirectory: "/sessions",
  resolvedSessionDirectory: "/resolved",
};
const input = {
  requestId: "storage-worker",
  title: "Storage worker",
  assignment: {
    description: "Implement storage",
    body: "Own storage.ts and its tests; report on this board.",
  },
  model: { provider: "test", modelId: "test", thinkingLevel: "off" as const, fastMode: false },
  senderContext: { usedTokens: null, windowTokens: null },
};

/** Real family/board storage and durable admission; fake only the Pi boundary. */
const fixture = Effect.fn("ChildAssignmentTest.fixture")(function* (
  settings: {
    familyFiles?: Map<string, string>;
    boardFiles?: Map<string, string>;
    failAssignmentOnce?: boolean;
    assignmentGate?: Deferred.Deferred<void>;
    assignmentStarted?: Deferred.Deferred<void>;
    failConfigurationOnce?: boolean;
    failAdmissionOnce?: boolean;
    recoveryRecords?: ReadonlyArray<RuntimeRecoveryRecord>;
  } = {},
) {
  const family = familyStorageHarness(settings.familyFiles);
  const board = messageBoardHarness(settings.boardFiles);
  const core = yield* Layer.build(
    Layer.mergeAll(
      family.layer,
      projectTodoLayer(),
      board.layer,
      SessionCatalogChanges.layer,
      Layer.mock(PiModels, { resolve: (model) => Effect.succeed(model) }),
      Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed(undefined) }),
    ),
  );
  let context = core;
  if (settings.failAssignmentOnce || settings.assignmentGate) {
    const storage = Context.get(core, MessageBoardStorage);
    let fail = settings.failAssignmentOnce;
    context = Context.add(
      core,
      MessageBoardStorage,
      MessageBoardStorage.of({
        ...storage,
        append: (...args) => {
          if (fail) {
            fail = false;
            return Effect.fail(
              new MessageBoardError({ operation: "append", message: "Disk unavailable" }),
            );
          }
          return Effect.gen(function* () {
            if (settings.assignmentStarted)
              yield* Deferred.succeed(settings.assignmentStarted, undefined);
            if (settings.assignmentGate) yield* Deferred.await(settings.assignmentGate);
            return yield* storage.append(...args);
          });
        },
      }),
    );
  }
  const recoveryBase = yield* Layer.build(
    makeRuntimeRecoveryStorageTestLayer(settings.recoveryRecords),
  );
  const journal = Context.get(recoveryBase, RuntimeRecoveryStorage);
  let failAdmission = settings.failAdmissionOnce;
  const recovery = Context.add(
    recoveryBase,
    RuntimeRecoveryStorage,
    RuntimeRecoveryStorage.of({
      ...journal,
      update: (record) => {
        if (failAdmission) {
          failAdmission = false;
          return Effect.fail(
            new RuntimeRecoveryStorageError({
              operation: "update",
              message: "Admission disk unavailable",
            }),
          );
        }
        return journal.update(record);
      },
    }),
  );
  const firstRead = yield* Deferred.make<void>();
  let starts = 0;
  let acquisitions = 0;
  let failConfiguration = settings.failConfigurationOnce;
  let bootstrap = "";
  const runtimes = yield* Layer.build(
    makeCakeSessionRuntimesLayer({
      sessionIds: () => Stream.empty,
      catalog: () => Stream.empty,
      catalogEntry: () => Effect.succeed(undefined),
      inspect: () => Effect.succeed(undefined),
      changelog: () => Effect.succeed(""),
      createRuntime: (setup) => {
        acquisitions += 1;
        return Effect.succeed({
          ...fakeRuntime(setup, () => undefined),
          sessionId: setup.sessionId ?? "missing",
          applyConfiguration: async () => {
            if (failConfiguration) {
              failConfiguration = false;
              throw new Error("Configuration unavailable");
            }
          },
          prompt: async (text) => {
            starts += 1;
            bootstrap = text;
            await Effect.runPromise(
              Effect.gen(function* () {
                const descriptions = yield* boards.current(setup.sessionId ?? "missing");
                assert.equal(
                  descriptions.entries.length,
                  1,
                  "the fastest first read must find its assignment",
                );
                const entry = descriptions.entries[0];
                assert.ok(entry);
                const body = yield* boards.read(setup.sessionId ?? "missing", [entry.sequence]);
                assert.equal(body.entries[0]?.body, input.assignment.body);
                assert.deepEqual(body.entries[0]?.audience, [setup.sessionId]);
                yield* Deferred.succeed(firstRead, undefined);
              }).pipe(Effect.provide(context)),
            );
          },
        });
      },
    }).pipe(Layer.provide(Layer.succeedContext(recovery))),
  );
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(runtimes), Effect.provide(context), Effect.provide(recovery));
  const launch = (request = input) =>
    provide(
      createChild("parent", location, request, (id, childLocation, newSession) =>
        Effect.succeed(options({ cwd: childLocation.workingDirectory, sessionId: id, newSession })),
      ),
    );
  return {
    launch,
    provide,
    familyFiles: family.files,
    boardFiles: board.files,
    firstRead,
    starts: () => starts,
    acquisitions: () => acquisitions,
    bootstrap: () => bootstrap,
  };
});

describe("assignment-first child handoff", () => {
  it("rejects bootstrap-first callers and permits explicit reporting exceptions at the tool contract", () => {
    const operation = createSessionFamilyOperations(() => {
      throw new Error("Must not execute");
    }).find((item) => item.command === "sessions.create-child");
    assert.ok(operation?.inputSchema);
    const decode = Schema.decodeUnknownOption(operation.inputSchema);
    assert.ok(Option.isNone(decode({ title: "Child", initialPrompt: "Read the empty board" })));
    assert.ok(
      Option.isSome(
        decode({ title: "Child", assignment: input.assignment, resultDelivery: "reply" }),
      ),
    );
    assert.ok(Option.isSome(decode({ title: "Child", assignment: input.assignment })));
  });

  it.effect("holds creation non-executable until assignment persistence completes", () =>
    Effect.gen(function* () {
      const assignmentGate = yield* Deferred.make<void>();
      const assignmentStarted = yield* Deferred.make<void>();
      const f = yield* fixture({ assignmentGate, assignmentStarted });
      const launch = yield* f.launch().pipe(Effect.forkScoped);
      yield* Deferred.await(assignmentStarted);
      assert.equal(f.acquisitions(), 0);
      assert.equal(f.starts(), 0);
      yield* Deferred.succeed(assignmentGate, undefined);
      const result = yield* Fiber.join(launch);
      assert.equal(result.launch.status, "accepted");
      yield* Deferred.await(f.firstRead);
    }),
  );

  it.effect("cancellation while persisting the assignment cannot start the child later", () =>
    Effect.gen(function* () {
      const assignmentGate = yield* Deferred.make<void>();
      const assignmentStarted = yield* Deferred.make<void>();
      const f = yield* fixture({ assignmentGate, assignmentStarted });
      const launch = yield* f.launch().pipe(Effect.forkScoped);
      yield* Deferred.await(assignmentStarted);
      yield* Fiber.interrupt(launch);
      yield* Deferred.succeed(assignmentGate, undefined);
      assert.equal(f.acquisitions(), 0);
      assert.equal(f.starts(), 0);
    }),
  );

  it.effect(
    "persists the addressed body before even a fast child's first board read, without a private obligation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const result = yield* f.launch();
        assert.equal(result.launch.status, "accepted", JSON.stringify(result.launch));
        yield* Deferred.await(f.firstRead);
        assert.equal(result.assignment?.sequence, 1);
        const items = (yield* f.provide(todos.list("/project"))).items;
        assert.equal(items.length, 1);
        assert.equal(items[0]?.description, input.assignment.description);
        assert.equal(f.starts(), 1);
        const message = parseCrossSessionMessage(f.bootstrap());
        assert.equal(message?.metadata.expectsResponse, false);
        assert.equal(message?.metadata.resultDelivery, "ignore");
        assert.ok(
          !message?.text.includes(input.assignment.body),
          "the private bootstrap contains no task copy",
        );
        const state = yield* f.provide(
          Effect.gen(function* () {
            return yield* (yield* SessionFamilyStorage).state();
          }),
        );
        assert.deepEqual(state.turns, []);
      }),
  );

  it.effect(
    "does not acquire/start on assignment failure; retry reuses identity and posts once",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ failAssignmentOnce: true });
        const failed = yield* f.launch();
        assert.equal(failed.launch.status, "failed");
        assert.equal(failed.launch.stage, "assignment");
        assert.equal(failed.assignment, undefined);
        assert.equal(f.starts(), 0);
        assert.equal(f.acquisitions(), 0);
        const retry = yield* f.launch();
        assert.equal(retry.childSessionId, failed.childSessionId);
        assert.equal(retry.launch.status, "accepted");
        assert.equal(retry.assignment?.sequence, 1);
        assert.equal(f.starts(), 1);
      }),
  );

  it.effect("retries failed durable admission even when a runtime already exists", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ failAdmissionOnce: true });
      const failed = yield* f.launch();
      assert.equal(failed.launch.status, "failed");
      assert.equal(failed.launch.stage, "admission");
      assert.equal(f.starts(), 0);
      assert.equal((yield* f.provide(todos.list("/project"))).items.length, 0);
      const retry = yield* f.launch();
      assert.equal(retry.childSessionId, failed.childSessionId);
      assert.deepEqual(retry.assignment, failed.assignment);
      assert.equal(retry.launch.status, "accepted");
      assert.equal(f.starts(), 1);
    }),
  );

  it.effect(
    "retains a pre-admission handoff across storage reload/startup and retries configuration failure",
    () =>
      Effect.gen(function* () {
        const first = yield* fixture({ failConfigurationOnce: true });
        const failed = yield* first.launch();
        assert.equal(failed.launch.status, "failed");
        assert.equal(failed.launch.stage, "runtime");
        assert.equal(first.starts(), 0);
        const restarted = yield* fixture({
          familyFiles: first.familyFiles,
          boardFiles: first.boardFiles,
        });
        yield* restarted.provide(initialize("/sessions", "/resolved", () => Effect.succeed(false)));
        assert.equal(
          restarted.starts(),
          0,
          "startup must not bypass explicit retry or stop authority",
        );
        const result = yield* restarted.launch();
        assert.equal(result.childSessionId, failed.childSessionId);
        assert.deepEqual(result.assignment, failed.assignment);
        assert.equal(result.launch.status, "accepted");
        assert.equal(restarted.starts(), 1);
      }),
  );

  it.effect(
    "concurrent/repeated retries admit one input and one assignment even if the child finishes immediately",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const [a, b] = yield* Effect.all([f.launch(), f.launch()], { concurrency: 2 });
        assert.equal(a.childSessionId, b.childSessionId);
        const again = yield* f.launch();
        assert.equal(again.launch.status, "already-admitted");
        assert.equal(f.starts(), 1);
        assert.equal((yield* f.provide(todos.list("/project"))).items.length, 1);
        assert.deepEqual(a.assignment, b.assignment);
      }),
  );

  it.effect.each(["active", "blocked", "complete", "failed", "stopped"] as const)(
    "retry never resurrects an admitted %s journal after restart",
    (state) =>
      Effect.gen(function* () {
        const f = yield* fixture({ failConfigurationOnce: true });
        const reservation = yield* f.launch();
        const restarted = yield* fixture({
          familyFiles: f.familyFiles,
          boardFiles: f.boardFiles,
          recoveryRecords: [
            {
              sessionId: reservation.childSessionId,
              workingDirectory: "/project",
              sessionDirectory: "/sessions",
              profile: "ProjectSession",
              transcriptPersisted: false,
              inputs:
                state === "active" || state === "blocked"
                  ? [
                      {
                        turnId: reservation.childSessionId,
                        text: "Persisted board bootstrap",
                        delivery: "prompt",
                        attachments: [],
                        markdown: false,
                      },
                    ]
                  : [],
              state,
              ...(state === "stopped" ? { canceledInputIds: [reservation.childSessionId] } : null),
            },
          ],
        });
        const retry = yield* restarted.launch();
        assert.equal(retry.launch.status, "already-admitted");
        assert.equal(retry.launch.state, state);
        assert.equal(restarted.starts(), 0);
        assert.equal(restarted.acquisitions(), 0);
      }),
  );

  it.effect("a withdrawn queued input with a complete journal is not re-admitted", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ failConfigurationOnce: true });
      const reserved = yield* f.launch();
      const restarted = yield* fixture({
        familyFiles: f.familyFiles,
        boardFiles: f.boardFiles,
        recoveryRecords: [
          {
            sessionId: reserved.childSessionId,
            workingDirectory: "/project",
            sessionDirectory: "/sessions",
            profile: "ProjectSession",
            transcriptPersisted: false,
            inputs: [],
            state: "complete",
            canceledInputIds: [reserved.childSessionId],
          },
        ],
      });
      const retry = yield* restarted.launch();
      assert.equal(retry.launch.status, "already-admitted");
      assert.equal(restarted.acquisitions(), 0);
      assert.equal(restarted.starts(), 0);
    }),
  );

  it.effect("refuses to silently replace the persisted assignment on retry", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ failConfigurationOnce: true });
      yield* f.launch();
      const changed = yield* f.launch({
        ...input,
        assignment: { ...input.assignment, body: "Different task" },
      });
      assert.equal(changed.launch.status, "failed");
      assert.equal(changed.launch.stage, "assignment");
      assert.equal(f.starts(), 0);
    }),
  );
});
