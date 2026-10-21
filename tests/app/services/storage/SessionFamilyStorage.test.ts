import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { describe } from "vitest";
import { Effect, Struct } from "effect";
import { familyStorageHarness } from "../../helpers/familyStorageHarness";
import {
  SessionFamilyStorage,
  type FamilyTurn,
} from "../../../../src/services/storage/SessionFamilyStorage";

const testLayer = () => familyStorageHarness().layer;

const turn = (overrides: Partial<FamilyTurn> = {}): FamilyTurn => ({
  sessionId: "child",
  senderSessionId: "parent",
  turnId: "turn",
  requestMessageId: "request-message",
  threadId: "thread",
  reported: false,
  resultDelivery: "reply",
  ...overrides,
});

const child = (requestId: string, childSessionId: string) => ({
  familyId: crypto.randomUUID(),
  parentSessionId: "parent",
  parentWorkingDirectory: "/worktree",
  childSessionId,
  childWorkingDirectory: "/project/.cake-worktrees/feature",
  childManagedWorktreePath: "/project/.cake-worktrees/feature",
  requestId,
  projectPath: "/project",
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("SessionFamilyStorage", () => {
  it.effect(
    "migrates explicit v8 delivery pauses without carrying old budgets into default delivery",
    () => {
      const files = new Map([
        [
          "state/session-families.json",
          JSON.stringify({
            version: 8,
            data: {
              families: [],
              turns: [],
              spawnedSessions: [],
              boardContinuations: [
                { recipientSessionId: "parent", mode: "resume", remainingInputs: 0 },
                { recipientSessionId: "paused", mode: "paused", remainingInputs: 5 },
                { recipientSessionId: "off", mode: "off" },
              ],
            },
          }),
        ],
      ]);
      return Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        assert.deepEqual((yield* storage.state()).boardDeliveryPaused, ["paused", "off"]);
        for (const recipientSessionId of ["parent", "paused"]) {
          yield* storage.recordBoardDelivery({
            recipientSessionId,
            boardId: "board",
            sequences: [1],
            through: 1,
            turnId: crypto.randomUUID(),
            status: "pending",
          });
        }
        assert.deepEqual(
          (yield* storage.state()).boardDeliveries?.map((item) => item.status),
          ["pending", "canceled"],
        );
        assert.equal(JSON.parse(files.get("state/session-families.json")!).version, 10);
      }).pipe(Effect.provide(familyStorageHarness(files).layer));
    },
  );

  it.effect(
    "does not rearm a consumed notification when restart retries the still-pending settlement",
    () => {
      const harness = familyStorageHarness();
      return Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        const result = turn({ outcome: "complete", resultDelivery: "notification" });
        const digest = {
          id: result.turnId,
          coordinatorSessionId: "parent",
          sessionId: "child",
          title: "Worker",
          summary: "Finished",
          status: "completed" as const,
          reportedAt: "2026-01-01",
        };
        yield* storage.recordTurn(result);
        yield* storage.recordCompletion(
          {
            ...digest,
            state: "pending",
            kind: "ready",
            decisions: ["review"],
            resultMessageRef: "cake://session/child?message=exact",
          },
          digest,
        );
        yield* storage.removeDigest([digest.id]); // user admission wins before settlement is journaled
        const reopened = yield* Effect.gen(function* () {
          return yield* SessionFamilyStorage;
        }).pipe(Effect.provide(familyStorageHarness(harness.files).layer));
        yield* reopened.digestNotice(result.turnId, digest);
        yield* reopened.digestNotice(result.turnId, digest);
        assert.deepEqual((yield* reopened.state()).coordinatorDigest, []);
        assert.deepEqual((yield* reopened.state()).turns, []);
        assert.equal(
          (yield* reopened.state()).completionInbox?.[0]?.resultMessageRef,
          "cake://session/child?message=exact",
        );
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "migrates v7 delivery combinations and preserves obligations, links, retries and quiet inboxes across reopen",
    () => {
      const ref = "cake://session/child?message=exact-result";
      const modes = [
        { continuation: "resume", reportPolicy: "digest", expected: "reply" },
        { continuation: "none", reportPolicy: "interrupt", expected: "notification" },
        { reportPolicy: "digest", expected: "notification" },
        { expected: "reply" },
      ] as const;
      const legacyTurns = modes.map((mode, index) => ({
        ...turn({
          turnId: `turn-${index}`,
          outcome: "complete",
          report: { outcome: "result", text: "Persisted result", resultMessageRef: ref },
        }),
        resultDelivery: undefined,
        ...Struct.omit(mode, ["expected"]),
      }));
      const digest = {
        id: "already-quiet",
        sessionId: "child",
        title: "Worker",
        summary: "Ready",
        status: "completed",
        reportedAt: "2026-01-01",
      };
      const files = new Map([
        [
          "state/session-families.json",
          JSON.stringify({
            version: 7,
            data: {
              families: [],
              turns: legacyTurns,
              spawnedSessions: [],
              coordinatorDigest: [digest],
            },
          }),
        ],
      ]);
      return Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        const migrated = yield* storage.state();
        assert.deepEqual(
          migrated.turns.map((item) => item.resultDelivery),
          modes.map((item) => item.expected),
        );
        assert.ok(migrated.turns.every((item) => item.report?.resultMessageRef === ref));
        yield* storage.markNoticeAttempt("turn-0", "stable-admission");
        yield* storage.recordTurn(migrated.turns[0]!); // retry must not overwrite the admission or create another obligation
        const reopened = yield* Effect.gen(function* () {
          return yield* (yield* SessionFamilyStorage).state();
        }).pipe(Effect.provide(familyStorageHarness(files).layer));
        assert.equal(reopened.turns.length, modes.length);
        assert.equal(reopened.turns[0]?.deliveryTurnId, "stable-admission");
        assert.deepEqual(reopened.coordinatorDigest, [digest]);
        assert.equal(JSON.parse(files.get("state/session-families.json")!).version, 10);
        assert.ok(
          !JSON.stringify(
            JSON.parse(files.get("state/session-families.json")!).data.turns,
          ).includes("continuation"),
        );
      }).pipe(Effect.provide(familyStorageHarness(files).layer));
    },
  );

  it.effect(
    "preserves an application-captured result link when a worker explicitly classified the result",
    () =>
      Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        yield* storage.recordTurn(turn({ resultDelivery: "reply" }));
        yield* storage.recordReport("turn", {
          outcome: "completed",
          text: "Worker-authored classification",
        });
        yield* storage.settleTurn("turn", "complete", {
          outcome: "result",
          text: "Final assistant explanation",
          resultMessageRef: "cake://session/child?message=final",
        });
        assert.deepEqual((yield* storage.state()).turns[0]?.report, {
          outcome: "completed",
          text: "Worker-authored classification",
          resultMessageRef: "cake://session/child?message=final",
        });
      }).pipe(Effect.provide(testLayer())),
  );

  it.effect(
    "persists explicit handling separately from admission and deduplicates replay after reopening",
    () => {
      const harness = familyStorageHarness();
      const report = {
        id: "report",
        recipientSessionId: "chat",
        text: "Exact linked or inline handoff",
      };
      return Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        yield* storage.deferReferenceNotice(report);
        yield* storage.markReferenceAdmissions([report.id]);
        assert.deepEqual((yield* storage.state()).deferredReferences, [
          { ...report, admissions: 1 },
        ]);
        yield* storage.acknowledgeReports([
          {
            id: report.id,
            recipientSessionId: "chat",
            assistantPartId: "entry-text-0",
            disposition: "dismissed",
          },
        ]);
        const reloaded = yield* Effect.gen(function* () {
          return yield* SessionFamilyStorage;
        }).pipe(Effect.provide(familyStorageHarness(harness.files).layer));
        yield* reloaded.deferReferenceNotice(report);
        assert.deepEqual((yield* reloaded.state()).deferredReferences, []);
        assert.equal((yield* reloaded.state()).handledReports?.[0]?.disposition, "dismissed");
        // Receipts are conversation-scoped, not blanket suppression of another inbox.
        yield* reloaded.deferReferenceNotice({ ...report, recipientSessionId: "other-chat" });
        assert.equal((yield* reloaded.state()).deferredReferences?.length, 1);
      }).pipe(Effect.provide(harness.layer));
    },
  );
  it.effect(
    "withdraws only selected recipient reports and does not revive canceled explicit replies on settlement",
    () =>
      Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        const completed = turn({ outcome: "complete", deliveryTurnId: "recipient-report" });
        const activeReply = turn({ turnId: "active", replyMessageIds: ["reply"] });
        const unrelated = turn({ turnId: "keep", outcome: "complete" });
        const otherRecipient = turn({
          turnId: "other",
          senderSessionId: "other-parent",
          replyMessageIds: ["reply"],
          outcome: "complete",
        });
        for (const item of [completed, activeReply, unrelated, otherRecipient])
          yield* storage.recordTurn(item);
        yield* storage.withdrawNotices("parent", ["recipient-report", "reply"]);
        assert.deepEqual((yield* storage.state()).turns, [
          { ...activeReply, reported: true },
          unrelated,
          otherRecipient,
        ]);
        yield* storage.settleTurn("active", "complete");
        assert.deepEqual((yield* storage.state()).turns, [unrelated, otherRecipient]);
      }).pipe(Effect.provide(testLayer())),
  );

  it.effect(
    "migrates version 4 partial transitions to root-owned lifecycle without losing membership or delivery",
    () => {
      const family = {
        familyId: "family",
        parentSessionId: "parent",
        projectPath: "/project",
        workingDirectory: "/worktree",
        createdAt: "2026-01-01",
        children: [
          {
            sessionId: "child",
            parentSessionId: "parent",
            requestId: "request",
            workingDirectory: "/child-tree",
            createdAt: "2026-01-01",
          },
        ],
      };
      const files = new Map([
        [
          "state/session-families.json",
          JSON.stringify({
            version: 4,
            data: {
              families: [
                {
                  ...family,
                  children: family.children.map((child) => ({ ...child, resultDelivery: "reply" })),
                },
              ],
              transitions: [{ parentSessionId: "parent", resolved: true }],
              turns: [{ ...turn(), expectsResponse: true }],
            },
          }),
        ],
      ]);
      return Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        assert.deepEqual(yield* storage.state(), {
          families: [
            {
              ...family,
              children: family.children.map((child) => ({ ...child, resultDelivery: "reply" })),
            },
          ],
          turns: [turn()],
          spawnedSessions: [],
        });
        yield* storage.settleTurn("turn", "complete");
        const persisted = JSON.parse(files.get("state/session-families.json") ?? "{}");
        assert.deepEqual(persisted, {
          version: 10,
          data: {
            families: [
              {
                ...family,
                children: family.children.map((child) => ({ ...child, resultDelivery: "reply" })),
              },
            ],
            turns: [turn({ outcome: "complete" })],
            spawnedSessions: [],
          },
        });
      }).pipe(Effect.provide(familyStorageHarness(files).layer));
    },
  );
  it.effect("migrates membership-only storage without losing existing families", () => {
    const files = new Map([
      ["state/session-families.json", JSON.stringify({ version: 1, data: { families: [] } })],
    ]);
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      assert.deepEqual(yield* storage.state(), { families: [], turns: [], spawnedSessions: [] });
      yield* storage.addChild(child("request", "child"));
      yield* storage.recordTurn(turn());
      yield* storage.prepareResponse("child", "parent", "request-message", "response", []);
      yield* storage.confirmResponse("response");
      yield* storage.settleTurn("turn", "complete");
      assert.deepEqual((yield* storage.state()).turns, []);
      assert.equal((yield* storage.list()).length, 1);
      assert.equal(JSON.parse(files.get("state/session-families.json") ?? "{}").version, 10);
    }).pipe(Effect.provide(familyStorageHarness(files).layer));
  });

  it.effect("migrates flat version 2 children into direct children of the root", () => {
    const files = new Map([
      [
        "state/session-families.json",
        JSON.stringify({
          version: 2,
          data: {
            families: [
              {
                familyId: "family",
                parentSessionId: "parent",
                projectPath: "/project",
                workingDirectory: "/worktree",
                managedWorktreePath: "/worktree",
                createdAt: "2026-01-01T00:00:00.000Z",
                children: [
                  {
                    sessionId: "child",
                    requestId: "request",
                    createdAt: "2026-01-01T00:00:01.000Z",
                  },
                ],
              },
            ],
            transitions: [],
            turns: [],
          },
        }),
      ],
    ]);
    return Effect.gen(function* () {
      const family = (yield* (yield* SessionFamilyStorage).list())[0];
      assert.deepEqual(family?.children[0], {
        sessionId: "child",
        parentSessionId: "parent",
        requestId: "request",
        workingDirectory: "/worktree",
        managedWorktreePath: "/worktree",
        createdAt: "2026-01-01T00:00:01.000Z",
        resultDelivery: "reply",
      });
    }).pipe(Effect.provide(familyStorageHarness(files).layer));
  });

  it.effect("migrates version 3 turn correlation as response-expected work", () => {
    const files = new Map([
      [
        "state/session-families.json",
        JSON.stringify({
          version: 3,
          data: {
            families: [],
            transitions: [],
            turns: [
              {
                sessionId: "child",
                parentSessionId: "parent",
                turnId: "legacy-turn",
                reported: false,
              },
            ],
          },
        }),
      ],
    ]);
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      const [migrated] = (yield* storage.state()).turns;
      assert.deepEqual(migrated, {
        sessionId: "child",
        senderSessionId: "parent",
        turnId: "legacy-turn",
        requestMessageId: "legacy-turn",
        threadId: "legacy-turn",
        resultDelivery: "reply",
        reported: false,
      });
    }).pipe(Effect.provide(familyStorageHarness(files).layer));
  });

  it.effect("settles every pending obligation once, including aborted turns", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      const report = { outcome: "result" as const, text: "Substantive findings" };
      yield* storage.recordTurn(turn());
      yield* storage.settleTurn("turn", "complete", report);
      yield* storage.recordTurn(turn({ turnId: "aborted" }));
      yield* storage.settleTurn("aborted", "aborted");
      // A second settlement of the same turn never replaces the first outcome.
      yield* storage.settleTurn("turn", "failed");
      assert.deepEqual(
        (yield* storage.state()).turns.map((item) => [item.turnId, item.outcome, item.report]),
        [
          ["turn", "complete", report],
          ["aborted", "aborted", undefined],
        ],
      );
      // An obligation already satisfied by a confirmed reply clears silently.
      yield* storage.recordTurn(turn({ turnId: "answered", reported: true }));
      yield* storage.settleTurn("answered", "complete");
      assert.ok(!(yield* storage.state()).turns.some((item) => item.turnId === "answered"));
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("migrates version 6 journals to explicit reply obligations only", () => {
    const files = new Map<string, string>();
    const legacy = (turnId: string, expectsResponse: boolean) => ({
      sessionId: "child",
      senderSessionId: "parent",
      turnId,
      requestMessageId: turnId,
      threadId: "thread",
      expectsResponse,
      completionContract: expectsResponse,
      reported: false,
      outcome: "failed",
    });
    files.set(
      "state/session-families.json",
      JSON.stringify({
        version: 6,
        data: {
          families: [],
          spawnedSessions: [],
          turns: [legacy("requested", true), legacy("informational", false)],
        },
      }),
    );
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      assert.deepEqual((yield* storage.state()).turns, [
        {
          sessionId: "child",
          senderSessionId: "parent",
          turnId: "requested",
          resultDelivery: "reply",
          requestMessageId: "requested",
          threadId: "thread",
          reported: false,
          outcome: "failed",
        },
      ]);
    }).pipe(Effect.provide(familyStorageHarness(files).layer));
  });

  it.effect("only a response correlated to the request and sender satisfies it", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.recordTurn(turn());
      assert.equal(
        yield* storage.prepareResponse("child", "sibling", "request-message", "unrelated", []),
        false,
      );
      assert.equal(
        yield* storage.prepareResponse("child", "parent", "other-request", "unrelated", []),
        false,
      );
      assert.equal(
        yield* storage.prepareResponse("child", "parent", "request-message", "response", []),
        true,
      );
      yield* storage.confirmResponse("response");
      yield* storage.settleTurn("turn", "complete");
      assert.deepEqual((yield* storage.state()).turns, []);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("one reply covers every consumed request from the same sender", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.recordTurn(turn({ turnId: "initial", requestMessageId: "initial-request" }));
      yield* storage.recordTurn(
        turn({ turnId: "refinement", requestMessageId: "refinement-request" }),
      );
      yield* storage.recordTurn(
        turn({
          senderSessionId: "sibling",
          turnId: "sibling-turn",
          requestMessageId: "sibling-request",
        }),
      );
      yield* storage.recordTurn(
        turn({ turnId: "queued-turn", requestMessageId: "queued-request" }),
      );

      assert.equal(
        yield* storage.prepareResponse("child", "parent", "refinement-request", "response", [
          "initial",
          "refinement",
          "sibling-turn",
        ]),
        true,
      );
      yield* storage.confirmResponse("response");
      yield* storage.settleTurn("initial", "complete");
      yield* storage.settleTurn("refinement", "complete");

      const remaining = (yield* storage.state()).turns;
      assert.deepEqual(
        remaining.map((item) => item.turnId),
        ["sibling-turn", "queued-turn"],
      );
      assert.ok(remaining.every((item) => !item.reported));
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("selects only consumed requests while allowing delayed explicit correlation", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.recordTurn(turn({ turnId: "executing", requestMessageId: "active" }));
      yield* storage.recordTurn(
        turn({
          senderSessionId: "sibling",
          turnId: "queued",
          requestMessageId: "queued-request",
        }),
      );

      assert.equal(
        (yield* storage.pendingResponseRequest("child", ["executing"]))?.turnId,
        "executing",
      );
      assert.equal(
        yield* storage.pendingResponseRequest("child", ["executing"], "thread", "queued-request"),
        undefined,
      );

      yield* storage.settleTurn("executing", "complete");
      assert.equal(
        (yield* storage.pendingResponseRequest("child", [], "thread", "active"))?.turnId,
        "executing",
      );
      assert.equal(yield* storage.pendingResponseRequest("child", []), undefined);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("serializes concurrent first-child creation into one family", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      const [first, second] = yield* Effect.all(
        [
          storage.addChild(child("request-1", "child-1")),
          storage.addChild(child("request-2", "child-2")),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(first.familyId, second.familyId);
      const families = yield* storage.list();
      assert.equal(families.length, 1);
      assert.deepEqual(families[0]?.children.map((entry) => entry.sessionId).sort(), [
        "child-1",
        "child-2",
      ]);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("returns the original child for an idempotent creation request", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      const original = yield* storage.addChild(child("request-1", "child-1"));
      const retried = yield* storage.addChild(child("request-1", "different-child"));
      assert.equal(retried.familyId, original.familyId);
      assert.deepEqual(retried.children, original.children);
      assert.equal(original.parentSessionId, "parent");
      assert.equal(original.workingDirectory, "/worktree");
      assert.equal(original.managedWorktreePath, undefined);
      assert.equal(original.children[0]?.sessionId, "child-1");
      assert.equal(original.children[0]?.workingDirectory, "/project/.cake-worktrees/feature");
      assert.equal(original.children[0]?.managedWorktreePath, "/project/.cake-worktrees/feature");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("removes project families with their turn journals", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(child("request-1", "child-1"));
      yield* storage.addChild({
        ...child("request-2", "grandchild"),
        parentSessionId: "child-1",
        parentWorkingDirectory: "/project/.cake-worktrees/feature",
        parentManagedWorktreePath: "/project/.cake-worktrees/feature",
      });
      yield* storage.recordTurn(
        turn({
          sessionId: "grandchild",
          senderSessionId: "child-1",
          turnId: "turn-1",
          requestMessageId: "request-1",
        }),
      );
      yield* storage.removeProject("/project");
      assert.deepEqual(yield* storage.state(), { families: [], turns: [], spawnedSessions: [] });
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("stores recursive children with per-session Working Directory bindings", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(child("request-1", "child-1"));
      const parentBindingError = yield* Effect.flip(
        storage.addChild({
          ...child("wrong-parent-binding", "other-grandchild"),
          parentSessionId: "child-1",
          parentWorkingDirectory: "/wrong-worktree",
        }),
      );
      assert.match(parentBindingError.message, /parent Working Directory binding cannot change/);
      const family = yield* storage.addChild({
        ...child("request-2", "grandchild"),
        parentSessionId: "child-1",
        parentWorkingDirectory: "/project/.cake-worktrees/feature",
        parentManagedWorktreePath: "/project/.cake-worktrees/feature",
        childWorkingDirectory: "/project/.cake-worktrees/grandchild",
        childManagedWorktreePath: "/project/.cake-worktrees/grandchild",
      });
      assert.deepEqual(family.children, [
        {
          sessionId: "child-1",
          parentSessionId: "parent",
          requestId: "request-1",
          workingDirectory: "/project/.cake-worktrees/feature",
          managedWorktreePath: "/project/.cake-worktrees/feature",
          createdAt: "2026-01-01T00:00:00.000Z",
          resultDelivery: "notification",
        },
        {
          sessionId: "grandchild",
          parentSessionId: "child-1",
          requestId: "request-2",
          workingDirectory: "/project/.cake-worktrees/grandchild",
          managedWorktreePath: "/project/.cake-worktrees/grandchild",
          createdAt: "2026-01-01T00:00:00.000Z",
          resultDelivery: "notification",
        },
      ]);
    }).pipe(Effect.provide(testLayer())),
  );
});
