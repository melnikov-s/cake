import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";
import * as boards from "../../../src/domain/artifacts/messageBoards";
import * as artifacts from "../../../src/domain/artifacts/artifactWorkflows";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { MessageBoardStorage } from "../../../src/services/storage/MessageBoardStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { messageBoardHarness } from "../helpers/messageBoardHarness";
import { familyStorageHarness } from "../helpers/familyStorageHarness";

const family = {
  familyId: "family",
  parentSessionId: "parent",
  projectPath: "/project",
  workingDirectory: "/parent-tree",
  createdAt: "2026-01-01T00:00:00Z",
  children: [
    {
      sessionId: "child",
      parentSessionId: "parent",
      requestId: "child",
      workingDirectory: "/isolated-tree",
      createdAt: "2026-01-01T00:00:00Z",
    },
    {
      sessionId: "sibling",
      parentSessionId: "parent",
      requestId: "sibling",
      workingDirectory: "/parent-tree",
      createdAt: "2026-01-01T00:00:00Z",
    },
  ],
};
const familyLayer = Layer.mock(SessionFamilyStorage, {
  familyForMember: (id) =>
    Effect.succeed(["parent", "child", "sibling"].includes(id) ? family : undefined),
  list: () => Effect.succeed([family]),
});
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.merge(messageBoardHarness().layer, familyLayer)));

describe("Workboard policy", () => {
  it.effect("creates one family artifact and preserves concurrent appends in stable order", () =>
    run(
      Effect.gen(function* () {
        const board = yield* boards.ensureBoard(family, "  Editor isolation  ");
        const again = yield* boards.ensureBoard(family, "Another member's title");
        expect(again.lineageId).toBe(board.lineageId);
        expect(board.snapshot.title).toBe("Editor isolation");
        expect(again.snapshot.title).toBe("Editor isolation");
        const posts = yield* Effect.all(
          Array.from({ length: 12 }, (_, index) =>
            boards.append(index % 2 ? "child" : "parent", {
              description: `Finding ${index}`,
              body: `Evidence ${index}`,
            }),
          ),
          { concurrency: "unbounded" },
        );
        expect(posts.map((post) => post.entry.sequence).toSorted((a, b) => a - b)).toEqual(
          Array.from({ length: 12 }, (_, index) => index + 1),
        );
        const entries = yield* (yield* MessageBoardStorage).entries(board.lineageId);
        expect(new Set(entries.map((entry) => entry.body)).size).toBe(12);
        expect(entries.map((entry) => entry.sequence)).toEqual(
          Array.from({ length: 12 }, (_, index) => index + 1),
        );
        const catalog = yield* (yield* ArtifactStorage).catalog();
        expect(catalog.lineages).toHaveLength(1);
        expect(catalog.links[0]?.target).toEqual({ type: "family", familyId: "family" });
        expect(catalog.lineages[0]?.latestRevision).toBe(1);
      }),
    ),
  );
  it.effect(
    "filters relevant unread descriptions, pages, and retains deferred entries without notifying twice",
    () =>
      run(
        Effect.gen(function* () {
          yield* boards.ensureBoard(family);
          yield* boards.append("parent", { description: "Family", body: "Family evidence" });
          yield* boards.append("parent", {
            description: "Child only",
            body: "Child evidence",
            audience: ["child"],
          });
          yield* boards.append("parent", {
            description: "Sibling only",
            body: "Sibling evidence",
            audience: ["sibling"],
          });
          yield* boards.append("child", { description: "My own result", body: "My evidence" });
          const first = yield* boards.readNew("child", { limit: 1 });
          expect(first.entries.map((entry) => entry.sequence)).toEqual([1]);
          expect(first.hasMore).toBe(true);
          expect(yield* boards.readNew("child", { after: first.nextAfter })).toMatchObject({
            entries: [{ sequence: 2 }],
            hasMore: false,
          });
          expect(
            (yield* boards.readNew("child", { limit: 1 }, true, [
              { boardId: first.boardId, sequence: 1 },
            ])).entries.map((entry) => entry.sequence),
          ).toEqual([2]);
          yield* boards.recordIntake("child", first.boardId, [1], "notifiedAt");
          expect(
            (yield* boards.readNew("child", {}, true)).entries.map((entry) => entry.sequence),
          ).toEqual([2]);
          expect((yield* boards.readNew("child")).entries.map((entry) => entry.sequence)).toEqual([
            1, 2,
          ]);
          yield* boards.recordIntake("child", first.boardId, [2], "readAt");
          expect((yield* boards.readNew("child", {}, true)).entries).toEqual([]);
          const receipt = yield* boards.entryReceipts("parent", 2);
          expect(receipt.receipts).toEqual([
            { sequence: 2, sessionId: "child", readAt: expect.any(String) },
          ]);
          const session = yield* boards.sessionReceipts("parent", "child");
          expect(session.entries[0]?.receipt.notifiedAt).toEqual(expect.any(String));
          expect(session.entries[0]?.receipt.readAt).toBeUndefined();
        }),
      ),
  );
  it.effect("internal fetch and human artifact browsing never stamp agent receipts", () =>
    run(
      Effect.gen(function* () {
        const board = yield* boards.ensureBoard(family);
        yield* boards.append("parent", { description: "Finding", body: "Full evidence" });
        expect(board.snapshot.title).toBe("Workboard");
        expect((yield* boards.read("child", [1])).entries[0]?.body).toBe("Full evidence");
        expect((yield* boards.browse(board.lineageId, {})).entries[0]?.description).toBe("Finding");
        expect((yield* boards.browseBody(board.lineageId, 1)).body).toBe("Full evidence");
        expect(
          (yield* boards.browseReceipts(board.lineageId, 1)).receipts.every(
            (receipt) => receipt.readAt === undefined && receipt.notifiedAt === undefined,
          ),
        ).toBe(true);
        yield* boards.recordIntake("child", board.lineageId, [1], "readAt");
        const original = yield* (yield* MessageBoardStorage).receipts(board.lineageId);
        yield* boards.recordIntake("child", board.lineageId, [1], "readAt");
        expect(yield* (yield* MessageBoardStorage).receipts(board.lineageId)).toEqual(original);
      }),
    ),
  );
  it.effect("rejects outsiders, invalid audiences, and generic board replacement", () =>
    run(
      Effect.gen(function* () {
        const board = yield* boards.ensureBoard(family);
        expect(
          (yield* Effect.result(boards.append("outsider", { description: "Bad", body: "Bad" })))
            ._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.result(
            boards.append("child", { description: "Bad", body: "Bad", audience: ["outsider"] }),
          ))._tag,
        ).toBe("Failure");
        expect((yield* Effect.result(boards.sessionReceipts("child", "outsider")))._tag).toBe(
          "Failure",
        );
        expect(
          (yield* Effect.result(boards.recordIntake("child", "other-board", [1], "readAt")))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.result(
            artifacts.publish({
              sessionId: "child",
              lineageId: board.lineageId,
              expectedLatestRevision: 1,
              workingDirectory: "/isolated-tree",
              snapshot: { ...board.snapshot, sessionId: "child", revision: 2 },
            }),
          ))._tag,
        ).toBe("Failure");
      }),
    ),
  );
  it.effect("retains individual entries and independent receipts after reacquisition", () =>
    Effect.gen(function* () {
      const harness = messageBoardHarness();
      const layer = Layer.merge(harness.layer, familyLayer);
      const id = yield* Effect.gen(function* () {
        const board = yield* boards.ensureBoard(family);
        yield* boards.append("parent", { description: "Persisted", body: "Evidence" });
        yield* boards.recordIntake("child", board.lineageId, [1], "notifiedAt");
        return board.lineageId;
      }).pipe(Effect.provide(layer));
      yield* Effect.gen(function* () {
        expect((yield* boards.readNew("child", {}, true)).entries).toEqual([]);
        expect((yield* boards.readNew("child")).entries).toHaveLength(1);
        expect((yield* boards.read("child", [1])).boardId).toBe(id);
      }).pipe(Effect.provide(Layer.merge(messageBoardHarness(harness.files).layer, familyLayer)));
    }),
  );
  it.effect("concurrent first-child reservations share one board, including descendants", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      const create = (childId: string, parentId = "root") =>
        storage.withMemberLock(
          parentId,
          Effect.gen(function* () {
            const value = yield* storage.addChild({
              familyId: childId,
              parentSessionId: parentId,
              parentWorkingDirectory: parentId === "root" ? "/tree" : `/${parentId}-tree`,
              childSessionId: childId,
              childWorkingDirectory: `/${childId}-tree`,
              requestId: childId,
              projectPath: "/project",
              createdAt: "2026-01-01T00:00:00Z",
            });
            return yield* boards.ensureBoard(value);
          }),
        );
      const first = yield* Effect.all([create("a"), create("b")], { concurrency: "unbounded" });
      const descendant = yield* create("grandchild", "a");
      expect(new Set([...first, descendant].map((board) => board.lineageId)).size).toBe(1);
      expect((yield* (yield* ArtifactStorage).catalog()).lineages).toHaveLength(1);
      yield* boards.append("grandchild", {
        description: "Discovery",
        body: "Evidence from a separate worktree",
      });
      expect((yield* boards.readNew("root")).entries).toHaveLength(1);
    }).pipe(Effect.provide(Layer.merge(messageBoardHarness().layer, familyStorageHarness().layer))),
  );
});
