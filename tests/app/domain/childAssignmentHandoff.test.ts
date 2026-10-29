import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Layer, Stream, Schema, Option, Fiber, Logger } from "effect";
import { describe } from "vitest";
import {
  resultDeliveryBehavior,
  type ResultDelivery,
} from "../../../src/contracts/conversations/result-delivery";
import operatingBasics from "../../../docs/agent/family-startup.md?raw";
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
import { fullProjectTodos, projectTodoLayer } from "../helpers/projectTodoHarness";
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
    todoSettings?: Parameters<typeof projectTodoLayer>[0];
    failAssignmentOnce?: boolean;
    assignmentGate?: Deferred.Deferred<void>;
    assignmentStarted?: Deferred.Deferred<void>;
    failConfigurationOnce?: boolean;
    failAdmissionOnce?: boolean;
    promptGate?: Deferred.Deferred<void>;
    recoveryRecords?: ReadonlyArray<RuntimeRecoveryRecord>;
  } = {},
) {
  const family = familyStorageHarness(settings.familyFiles);
  const board = messageBoardHarness(settings.boardFiles);
  const core = yield* Layer.build(
    Layer.mergeAll(
      family.layer,
      projectTodoLayer(settings.todoSettings),
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
  const firstPrompt = yield* Deferred.make<void>();
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
            setup.onInitialTranscriptPersisted?.();
            starts += 1;
            bootstrap = text;
            await Effect.runPromise(
              Effect.gen(function* () {
                const sessionId = setup.sessionId ?? "missing";
                const family = yield* (yield* SessionFamilyStorage).familyForMember(sessionId);
                assert.ok(family);
                const entries = yield* (yield* MessageBoardStorage).entries(
                  boards.boardIdFor(family.familyId),
                );
                const addressed = entries.filter(
                  (entry) => entry.audience !== "workgroup" && entry.audience.includes(sessionId),
                );
                assert.equal(addressed.length, 1, "assignment must be durable before execution");
                const entry = addressed[0];
                assert.ok(entry);
                assert.deepEqual(entry.audience, [sessionId]);
                const message = parseCrossSessionMessage(text);
                assert.ok(message);
                assert.equal(message.text.split(operatingBasics.trim()).length - 1, 1);
                assert.ok(
                  message.text.endsWith(`Description: ${entry.description}\n\n${entry.body}`),
                );
                assert.equal(message.text.split(entry.body).length - 1, 1);
                assert.equal(message.text.split(entry.description).length - 1, 1);
                assert.equal(message.metadata.sender.sessionId, entry.authorSessionId);
                assert.equal(message.metadata.messageId, sessionId);
                assert.equal(message.metadata.threadId, family.familyId);
                yield* Deferred.succeed(firstPrompt, undefined);
                if (settings.promptGate) yield* Deferred.await(settings.promptGate);
              }).pipe(Effect.provide(context)),
            );
          },
        });
      },
    }).pipe(Layer.provide(Layer.succeedContext(recovery))),
  );
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(runtimes), Effect.provide(context), Effect.provide(recovery));
  const launch = (request: typeof input & { resultDelivery?: ResultDelivery } = input) =>
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
    firstPrompt,
    starts: () => starts,
    acquisitions: () => acquisitions,
    bootstrap: () => bootstrap,
  };
});

describe("assignment-first child handoff", () => {
  it("rejects bootstrap-first callers and accepts explicit result modes at the tool contract", () => {
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
      yield* Deferred.await(f.firstPrompt);
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

  it.effect("admits the full addressed assignment once without an initial board read", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const result = yield* f.launch();
      assert.equal(result.launch.status, "accepted", JSON.stringify(result.launch));
      yield* Deferred.await(f.firstPrompt);
      assert.equal(result.assignment?.sequence, 1);
      const items = (yield* f.provide(todos.list("/project"))).items;
      assert.equal(items.length, 1);
      assert.equal(items[0]?.description, input.assignment.description);
      assert.equal(f.starts(), 1);
      const message = parseCrossSessionMessage(f.bootstrap());
      assert.equal(message?.metadata.expectsResponse, true);
      assert.equal(message?.metadata.resultDelivery, "notification");
      assert.ok(message?.text.includes(input.assignment.body));
      assert.ok(message.text.includes(input.assignment.description));
      assert.ok(message.text.includes(`board ${result.assignment?.boardId}, entry #1`));
      assert.ok(message.text.includes(`topic child-${result.childSessionId}`));
      assert.ok(message.text.includes("no initial boards.read is needed"));
      assert.ok(message.text.includes("Use the Workboard for later updates"));
      const receipts = yield* f.provide(boards.entryReceipts("parent", 1));
      assert.equal(
        receipts.receipts.find((receipt) => receipt.sessionId === result.childSessionId)?.readAt,
        undefined,
        "inline admission does not manufacture an agent board-read receipt",
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

  for (const failure of ["full list", "storage failure"] as const) {
    it.effect(`keeps child admission and retries truthful despite to-do ${failure}`, () =>
      Effect.gen(function* () {
        const promptGate = yield* Deferred.make<void>();
        const f = yield* fixture({
          promptGate,
          todoSettings:
            failure === "full list" ? { initialTodos: fullProjectTodos() } : { failSave: true },
        });
        const logs: unknown[] = [];
        const logger = Logger.layer([
          Logger.make((entry) => {
            logs.push(entry.message);
          }),
        ]);
        const first = yield* f.launch().pipe(Effect.provide(logger));
        yield* Deferred.await(f.firstPrompt);
        assert.equal(first.launch.status, "accepted");
        const record = yield* f.provide(
          Effect.flatMap(RuntimeRecoveryStorage, (storage) => storage.get(first.childSessionId)),
        );
        assert.equal(record?.sessionId, first.childSessionId);
        assert.deepEqual(
          record?.inputs.map((input) => input.turnId),
          [first.launch.turnId],
        );
        const retry = yield* f.launch().pipe(Effect.provide(logger));
        assert.equal(retry.childSessionId, first.childSessionId);
        assert.equal(retry.familyId, first.familyId);
        assert.deepEqual(retry.assignment, first.assignment);
        assert.equal(retry.launch.status, "already-admitted");
        assert.equal(retry.launch.state, "active");
        assert.equal(f.starts(), 1);
        assert.equal(f.acquisitions(), 1);
        assert.equal(logs.length, 2);
        for (const log of logs) {
          assert.match(String(log), /Accepted session could not be recorded/);
          assert.match(
            String(log),
            failure === "full list" ? /To-do list is full/ : /To-do disk unavailable/,
          );
        }
        yield* Deferred.succeed(promptGate, undefined);
      }),
    );
  }

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
        yield* Deferred.await(restarted.firstPrompt);
        assert.ok(
          parseCrossSessionMessage(restarted.bootstrap())?.text.endsWith(input.assignment.body),
        );
        const persisted = yield* restarted.provide(boards.read("parent", [1]));
        assert.equal(persisted.entries.length, 1);
        assert.equal(persisted.entries[0]?.body, input.assignment.body);
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
        assert.equal((yield* f.provide(boards.current(a.childSessionId))).entries.length, 1);
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

  it.effect("includes maximum-length multiline assignment contents without truncation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const body = `\n# Task\n\n\`\`\`ts\n${"x".repeat(32_730)}\n\`\`\`\n尾🙂\n`;
      const assignment = { description: "D".repeat(512), body: body.padEnd(32_768, " ") };
      assert.equal(assignment.body.length, 32_768);
      const result = yield* f.launch({ ...input, assignment });
      assert.equal(result.launch.status, "accepted");
      yield* Deferred.await(f.firstPrompt);
      assert.ok(parseCrossSessionMessage(f.bootstrap())?.text.endsWith(assignment.body));
      const persisted = yield* f.provide(boards.read("parent", [1]));
      assert.equal(persisted.entries[0]?.body, assignment.body);
      assert.equal(persisted.entries[0]?.description, assignment.description);
    }),
  );

  it.effect(
    "retains the exact inline prompt in durable admission across restart without relaunch",
    () =>
      Effect.gen(function* () {
        const promptGate = yield* Deferred.make<void>();
        const f = yield* fixture({ promptGate });
        const launching = yield* f.launch().pipe(Effect.forkScoped);
        yield* Deferred.await(f.firstPrompt);
        const childSessionId = parseCrossSessionMessage(f.bootstrap())?.metadata.messageId;
        assert.ok(childSessionId);
        const record = yield* f.provide(
          Effect.gen(function* () {
            return yield* (yield* RuntimeRecoveryStorage).get(childSessionId);
          }),
        );
        assert.ok(record);
        assert.equal(record.inputs.length, 1);
        assert.equal(record.inputs[0]?.text, f.bootstrap());
        yield* Deferred.succeed(promptGate, undefined);
        const result = yield* Fiber.join(launching);
        const restarted = yield* fixture({
          familyFiles: f.familyFiles,
          boardFiles: f.boardFiles,
          recoveryRecords: [record],
        });
        yield* restarted.provide(initialize("/sessions", "/resolved", () => Effect.succeed(true)));
        const retry = yield* restarted.launch();
        assert.equal(retry.launch.status, "already-admitted");
        assert.equal(restarted.starts(), 0);
        assert.deepEqual(retry.assignment, result.assignment);
      }),
  );

  it.effect(
    "later board updates remain separately readable without replacing the initial task",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const result = yield* f.launch();
        yield* Deferred.await(f.firstPrompt);
        yield* f.provide(
          boards.append("parent", {
            description: "Adjust storage scope",
            body: "Also cover empty storage.",
            audience: [result.childSessionId],
            topic: "storage-update",
            event: "assignment",
          }),
        );
        const updates = yield* f.provide(boards.readNew(result.childSessionId));
        assert.ok(updates.entries.some((entry) => entry.sequence === 2));
        const read = yield* f.provide(boards.read(result.childSessionId, [2]));
        assert.equal(read.entries[0]?.body, "Also cover empty storage.");
        const initial = yield* f.provide(boards.read(result.childSessionId, [1]));
        assert.equal(initial.entries[0]?.body, input.assignment.body);
        assert.equal(f.starts(), 1);
        assert.ok(parseCrossSessionMessage(f.bootstrap())?.text.endsWith(input.assignment.body));
      }),
  );

  for (const mode of ["reply", "notification", "ignore"] as const) {
    it.effect(`admits self-contained startup with effective ${mode} behavior`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const result = yield* f.launch({ ...input, resultDelivery: mode });
        yield* Deferred.await(f.firstPrompt);
        const message = parseCrossSessionMessage(f.bootstrap());
        assert.ok(message);
        assert.equal(message.metadata.resultDelivery, mode);
        assert.equal(message.metadata.expectsResponse, mode !== "ignore");
        assert.ok(message.text.includes(`This launch uses resultDelivery: ${mode}.`));
        assert.ok(message.text.includes(resultDeliveryBehavior[mode]));
        assert.ok(message.text.includes(`Child public session ref: ${result.childSessionId}`));
        assert.ok(message.text.includes('"audience":["parent"]'));
        const receipts = yield* f.provide(boards.entryReceipts("parent", 1));
        assert.equal(
          receipts.receipts.find((receipt) => receipt.sessionId === result.childSessionId)?.readAt,
          undefined,
        );
      }),
    );
  }

  it.effect("renders the reserved mode on retry, not a conflicting later caller choice", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ failConfigurationOnce: true });
      const failed = yield* f.launch({ ...input, resultDelivery: "reply" });
      assert.equal(failed.launch.status, "failed");
      const retried = yield* f.launch({ ...input, resultDelivery: "ignore" });
      yield* Deferred.await(f.firstPrompt);
      assert.equal(retried.resultDelivery, "reply");
      assert.ok(
        parseCrossSessionMessage(f.bootstrap())?.text.includes(resultDeliveryBehavior.reply),
      );
      assert.equal(parseCrossSessionMessage(f.bootstrap())?.metadata.resultDelivery, "reply");
    }),
  );

  it.effect("addresses a recursive child's immediate parent while retaining the family root", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const parent = yield* f.launch();
      const nested = yield* f.provide(
        createChild(
          parent.childSessionId,
          location,
          {
            ...input,
            requestId: "nested-worker",
            assignment: { description: "Nested task", body: "Do the nested slice." },
            resultDelivery: "ignore",
          },
          (id, childLocation, newSession) =>
            Effect.succeed(
              options({ cwd: childLocation.workingDirectory, sessionId: id, newSession }),
            ),
        ),
      );
      assert.equal(nested.launch.status, "accepted");
      assert.equal(nested.familyDepth, 2);
      const message = parseCrossSessionMessage(f.bootstrap());
      assert.ok(message);
      assert.equal(message.metadata.sender.sessionId, parent.childSessionId);
      assert.ok(
        message.text.includes(`Immediate parent public session ref: ${parent.childSessionId}`),
      );
      assert.ok(message.text.includes("Family root public session ref: parent"));
      assert.ok(message.text.includes(`"audience":["${parent.childSessionId}"]`));
      assert.ok(message.text.includes("entry #2"));
      assert.equal(f.starts(), 2);
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
