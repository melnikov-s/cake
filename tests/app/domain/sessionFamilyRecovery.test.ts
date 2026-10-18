import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { initialize } from "../../../src/domain/session-families/sessionFamilies";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { RuntimeRecoveryStorage } from "../../../src/services/storage/RuntimeRecoveryStorage";
import {
  SessionFamilyStorage,
  type FamilyTurn,
} from "../../../src/services/storage/SessionFamilyStorage";
import { familyStorageHarness } from "../helpers/familyStorageHarness";

const child = {
  familyId: "family",
  parentSessionId: "parent",
  parentWorkingDirectory: "/project",
  childSessionId: "child",
  childWorkingDirectory: "/project",
  requestId: "create",
  projectPath: "/project",
  createdAt: "2026-01-01",
};
const turn = (turnId: string, overrides: Partial<FamilyTurn> = {}): FamilyTurn => ({
  sessionId: "child",
  senderSessionId: "parent",
  turnId,
  requestMessageId: turnId,
  threadId: "family",
  reported: false,
  ...overrides,
});
const archive = Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed(undefined) });

it.effect.each(["notification", "reply", "ignore"] as const)(
  "retains %s resultDelivery through pre-admission family and chat-launch crash recovery",
  (resultDelivery) =>
    Effect.gen(function* () {
      const files = new Map<string, string>();
      const layer = () => Layer.merge(familyStorageHarness(files).layer, archive);
      yield* Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        yield* storage.addChild({ ...child, resultDelivery });
        yield* storage.registerSpawn({
          sessionId: "spawn",
          projectPath: "/project",
          workingDirectory: "/project",
          requester: { sessionId: "cake-chat", kind: "cake-chat", title: "Cake Chat" },
          reportDelivered: false,
          handoffSettled: resultDelivery === "ignore",
          resultDelivery,
        });
      }).pipe(Effect.provide(layer()));
      for (let pass = 0; pass < 2; pass++)
        yield* Effect.gen(function* () {
          yield* initialize("/sessions", "/resolved", () => Effect.succeed(false));
          const turns = (yield* (yield* SessionFamilyStorage).state()).turns;
          assert.equal(turns.length, resultDelivery === "ignore" ? 0 : 2);
          assert.ok(turns.every((turn) => turn.resultDelivery === resultDelivery));
          if (resultDelivery !== "ignore") {
            assert.equal(turns.find((turn) => turn.sessionId === "child")?.outcome, "failed");
            assert.equal(turns.find((turn) => turn.sessionId === "spawn")?.outcome, "aborted");
          }
        }).pipe(Effect.provide(layer()));
    }),
);

it.effect(
  "initialization twice across recreation preserves blocked recovery obligations and settled report journals",
  () => {
    const files = new Map<string, string>();
    const layer = () =>
      Layer.mergeAll(
        familyStorageHarness(files).layer,
        archive,
        Layer.mock(RuntimeRecoveryStorage, {
          list: () =>
            Effect.succeed([
              {
                sessionId: "child",
                workingDirectory: "/project",
                sessionDirectory: "/sessions",
                profile: "ProjectSession",
                transcriptPersisted: true,
                state: "blocked",
                issue: "Uncertain tool execution",
                inputs: [
                  {
                    turnId: "accepted",
                    text: "Continue work",
                    delivery: "prompt",
                    attachments: [],
                    markdown: false,
                  },
                ],
              },
            ]),
        }),
      );
    const active = turn("accepted", {
      replyMessageIds: ["explicit-reply"],
      deliveryTurnId: "reply-turn",
    });
    const settled = turn("settled", {
      outcome: "complete",
      report: { outcome: "completed", text: "Work completed" },
      replyMessageIds: ["settled-reply"],
      deliveryTurnId: "settled-reply-turn",
      resultDelivery: "notification",
    });
    const recoverable = (sessionId: string, turnId?: string) =>
      Effect.gen(function* () {
        const records = yield* (yield* RuntimeRecoveryStorage).list();
        // Match startup policy: blocked work still owns its original reply obligation.
        return records.some(
          (record) =>
            record.sessionId === sessionId &&
            record.inputs.some((input) => turnId === undefined || input.turnId === turnId),
        );
      });
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        yield* storage.addChild(child);
        yield* storage.recordTurn(active);
        yield* storage.recordTurn(settled);
      }).pipe(Effect.provide(layer()));
      for (let pass = 0; pass < 2; pass++)
        yield* Effect.gen(function* () {
          yield* initialize("/sessions", "/resolved", recoverable);
          const storage = yield* SessionFamilyStorage;
          assert.equal((yield* storage.list())[0]?.children[0]?.sessionId, "child");
          assert.deepEqual((yield* storage.state()).turns, [active, settled]);
        }).pipe(Effect.provide(layer()));
    });
  },
);

it.effect(
  "preserves a digested report across restart and does not recreate it after next-user delivery",
  () => {
    const files = new Map<string, string>();
    const layer = () => Layer.merge(familyStorageHarness(files).layer, archive);
    const item = {
      id: "digested",
      sessionId: "spawn",
      coordinatorSessionId: "cake-chat",
      title: "Task",
      status: "completed" as const,
      summary: "Done",
      reportedAt: "2026-01-01",
    };
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        yield* storage.registerSpawn({
          sessionId: "spawn",
          projectPath: "/project",
          workingDirectory: "/project",
          requester: { sessionId: "cake-chat", kind: "cake-chat", title: "Cake Chat" },
          reportDelivered: false,
          handoffSettled: false,
          resultDelivery: "notification",
        });
        yield* storage.recordTurn(
          turn("digested", {
            sessionId: "spawn",
            senderSessionId: "cake-chat",
            requestMessageId: "spawn",
            outcome: "complete",
            resultDelivery: "notification",
            report: { outcome: "completed", text: "Done" },
          }),
        );
        yield* storage.digestNotice("digested", item);
      }).pipe(Effect.provide(layer()));
      for (let pass = 0; pass < 2; pass++)
        yield* Effect.gen(function* () {
          yield* initialize("/sessions", "/resolved", () => Effect.succeed(false));
          const storage = yield* SessionFamilyStorage;
          yield* storage.digestNotice("digested", item);
          assert.deepEqual((yield* storage.state()).coordinatorDigest, [item]);
          assert.deepEqual((yield* storage.state()).turns, []);
          assert.equal((yield* storage.state()).spawnedSessions[0]?.reportDelivered, true);
        }).pipe(Effect.provide(layer()));
      yield* Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        // The caller removes IDs only after the next user message has been accepted.
        yield* storage.removeDigest(["digested"]);
      }).pipe(Effect.provide(layer()));
      yield* Effect.gen(function* () {
        yield* initialize("/sessions", "/resolved", () => Effect.succeed(false));
        const storage = yield* SessionFamilyStorage;
        yield* storage.digestNotice("digested", item);
        assert.deepEqual((yield* storage.state()).coordinatorDigest, []);
        assert.deepEqual((yield* storage.state()).turns, []);
      }).pipe(Effect.provide(layer()));
    });
  },
);

it.effect(
  "preserves admitted child and spawned reservations before their first transcript or obligation write",
  () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(child);
      yield* storage.registerSpawn({
        sessionId: "spawn",
        projectPath: "/project",
        workingDirectory: "/project",
        requester: { sessionId: "cake-chat", kind: "cake-chat", title: "Cake Chat" },
        reportDelivered: false,
        handoffSettled: false,
        resultDelivery: "notification",
      });
      for (let pass = 0; pass < 2; pass++)
        yield* initialize("/sessions", "/resolved", () => Effect.succeed(true));
      assert.equal((yield* storage.list())[0]?.children.length, 1);
      assert.deepEqual((yield* storage.state()).turns, []);
      assert.equal((yield* storage.state()).spawnedSessions[0]?.handoffSettled, false);
    }).pipe(Effect.provide(Layer.merge(familyStorageHarness().layer, archive))),
);

it.effect(
  "settles only orphaned active obligations and preserves existing settled reports without duplicate notices",
  () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(child);
      const settled = turn("settled", {
        outcome: "complete",
        report: { outcome: "result", text: "Result" },
      });
      yield* storage.recordTurn(turn("orphan"));
      yield* storage.recordTurn(settled);
      for (let pass = 0; pass < 2; pass++)
        yield* initialize("/sessions", "/resolved", () => Effect.succeed(false));
      assert.deepEqual((yield* storage.state()).turns, [
        turn("orphan", { outcome: "aborted" }),
        settled,
      ]);
      assert.equal((yield* storage.list())[0]?.children.length, 1);
    }).pipe(Effect.provide(Layer.merge(familyStorageHarness().layer, archive))),
);
