import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { BoardAppendInput } from "../../../src/contracts/artifacts/message-board";
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
  state: () => Effect.succeed({ families: [family], turns: [], spawnedSessions: [] }),
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
              audience: "workgroup",
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
          yield* boards.append("parent", {
            audience: "workgroup",
            description: "Family",
            body: "Family evidence",
          });
          yield* boards.append("parent", {
            event: "assignment",
            description: "Child only",
            body: "Child evidence",
            audience: ["child"],
          });
          yield* boards.append("parent", {
            description: "Sibling only",
            body: "Sibling evidence",
            audience: ["sibling"],
          });
          yield* boards.append("child", {
            audience: "workgroup",
            description: "My own result",
            body: "My evidence",
          });
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
  it.effect(
    "reports intended recipients and recorded out-of-audience intake without changing relevance",
    () => {
      const receiptFamily = {
        ...family,
        children: [
          ...family.children,
          {
            sessionId: "idle",
            parentSessionId: "parent",
            requestId: "idle",
            workingDirectory: "/parent-tree",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      };
      const receiptFamilyLayer = Layer.mock(SessionFamilyStorage, {
        familyForMember: () => Effect.succeed(receiptFamily),
        list: () => Effect.succeed([receiptFamily]),
        state: () => Effect.succeed({ families: [receiptFamily], turns: [], spawnedSessions: [] }),
      });
      return Effect.gen(function* () {
        const board = yield* boards.ensureBoard(receiptFamily);
        yield* boards.append("parent", {
          description: "Addressed finding",
          body: "Shared evidence",
          audience: ["child"],
        });
        yield* boards.append("parent", {
          audience: "workgroup",
          description: "Workgroup finding",
          body: "Other evidence",
        });
        yield* boards.recordIntake("idle", board.lineageId, [2], "notifiedAt");
        const storage = yield* MessageBoardStorage;
        const beforeBrowsing = yield* storage.receipts(board.lineageId);
        expect((yield* boards.entryReceipts("parent", 1)).receipts).toEqual([
          { sequence: 1, sessionId: "child" },
        ]);
        yield* boards.browse(board.lineageId, {});
        yield* boards.browseBody(board.lineageId, 1);
        expect((yield* boards.browseReceipts(board.lineageId, 1)).receipts).toEqual([
          { sequence: 1, sessionId: "child" },
        ]);
        expect(yield* storage.receipts(board.lineageId)).toEqual(beforeBrowsing);
        expect((yield* boards.readNew("child")).entries.map((entry) => entry.sequence)).toEqual([
          1, 2,
        ]);
        expect((yield* boards.readNew("sibling")).entries.map((entry) => entry.sequence)).toEqual([
          2,
        ]);
        expect((yield* boards.read("child", [1])).entries[0]?.body).toBe("Shared evidence");
        yield* boards.recordIntake("child", board.lineageId, [1], "readAt");
        yield* boards.recordIntake("sibling", board.lineageId, [1], "notifiedAt");
        expect((yield* boards.entryReceipts("parent", 1)).receipts).toEqual([
          { sequence: 1, sessionId: "child", readAt: expect.any(String) },
          { sequence: 1, sessionId: "sibling", notifiedAt: expect.any(String) },
        ]);
        expect((yield* boards.read("sibling", [1])).entries[0]?.body).toBe("Shared evidence");
        yield* boards.recordIntake("sibling", board.lineageId, [1], "readAt");
        const recorded = yield* storage.receipts(board.lineageId);
        const report = yield* boards.entryReceipts("parent", 1);
        expect(report.receipts).toEqual([
          { sequence: 1, sessionId: "child", readAt: expect.any(String) },
          {
            sequence: 1,
            sessionId: "sibling",
            notifiedAt: expect.any(String),
            readAt: expect.any(String),
          },
        ]);
        expect(yield* boards.browseReceipts(board.lineageId, 1)).toEqual(report);
        expect(yield* storage.receipts(board.lineageId)).toEqual(recorded);
        expect((yield* boards.readNew("child")).entries.map((entry) => entry.sequence)).toEqual([
          2,
        ]);
        expect((yield* boards.readNew("sibling")).entries.map((entry) => entry.sequence)).toEqual([
          2,
        ]);
        const session = yield* boards.sessionReceipts("parent", "sibling");
        expect(session.entries.map(({ entry }) => entry.sequence)).toEqual([2]);
        expect(session.entries[0]?.receipt).toEqual({ sequence: 2, sessionId: "sibling" });
      }).pipe(Effect.provide(Layer.merge(messageBoardHarness().layer, receiptFamilyLayer)));
    },
  );
  it.effect("internal fetch and human artifact browsing never stamp agent receipts", () =>
    run(
      Effect.gen(function* () {
        const board = yield* boards.ensureBoard(family);
        yield* boards.append("parent", {
          audience: "workgroup",
          description: "Finding",
          body: "Full evidence",
        });
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
  it.effect(
    "resolves short board audiences and receipt targets before storing canonical identities",
    () => {
      const parent = "00000000-0000-4000-8000-000000000001";
      const child = "00000000-0000-4000-8000-000012345678";
      const sibling = "00000000-0000-4000-8000-000112345678";
      const ids = [parent, child, sibling];
      const referenceFamily = {
        ...family,
        parentSessionId: parent,
        children: family.children.map((member, index) => ({
          ...member,
          parentSessionId: parent,
          sessionId: ids[index + 1] ?? child,
        })),
      };
      return Effect.gen(function* () {
        const board = yield* boards.ensureBoard(referenceFamily);
        for (const audience of [["12345678"], ["ffffffff"], ["outsider"]]) {
          expect(
            (yield* Effect.result(
              boards.append(parent, { audience, description: "Invalid target", body: "Evidence" }),
            ))._tag,
          ).toBe("Failure");
        }
        const post = yield* boards.append(parent, {
          audience: ["012345678", child],
          description: "Targeted contract",
          body: "Evidence",
        });
        expect(post.entry.audience).toEqual([child]);
        expect((yield* (yield* MessageBoardStorage).entries(board.lineageId))[0]?.audience).toEqual(
          [child],
        );
        expect((yield* boards.readNew(child)).entries).toHaveLength(1);
        expect((yield* boards.readNew(sibling)).entries).toHaveLength(0);
        expect((yield* boards.sessionReceipts(parent, "012345678")).sessionId).toBe(child);
        expect((yield* Effect.result(boards.sessionReceipts(parent, "12345678")))._tag).toBe(
          "Failure",
        );
        expect((yield* Effect.result(boards.sessionReceipts(parent, "ffffffff")))._tag).toBe(
          "Failure",
        );
      }).pipe(
        Effect.provide(
          Layer.merge(
            messageBoardHarness().layer,
            Layer.mock(SessionFamilyStorage, {
              familyForMember: (id) =>
                Effect.succeed(ids.includes(id) ? referenceFamily : undefined),
              list: () => Effect.succeed([referenceFamily]),
              state: () =>
                Effect.succeed({ families: [referenceFamily], turns: [], spawnedSessions: [] }),
            }),
          ),
        ),
      );
    },
  );
  it.effect("requires explicit audiences instead of silently broadcasting", () =>
    Effect.sync(() => {
      expect(
        Schema.decodeUnknownResult(BoardAppendInput)({ description: "Finding", body: "Evidence" })
          ._tag,
      ).toBe("Failure");
      expect(
        Schema.decodeUnknownResult(BoardAppendInput)({
          description: "Finding",
          body: "Evidence",
          audience: [],
        })._tag,
      ).toBe("Failure");
    }),
  );
  it.effect("current decisions and unread discovery respect recipient-specific supersession", () =>
    run(
      Effect.gen(function* () {
        const board = yield* boards.ensureBoard(family);
        yield* boards.append("parent", {
          audience: "workgroup",
          topic: "output",
          description: "Initial output",
          body: "Initial contract",
        });
        yield* boards.append("parent", {
          audience: ["child"],
          topic: "output",
          supersedes: [1],
          description: "Child correction",
          body: "Corrected contract",
        });
        yield* boards.append("parent", {
          audience: "workgroup",
          topic: "state",
          description: "State contract",
          body: "State evidence",
        });
        expect(
          (yield* boards.current("child", { topic: "output" })).entries.map(
            (entry) => entry.sequence,
          ),
        ).toEqual([2]);
        expect(
          (yield* boards.current("sibling", { topic: "output" })).entries.map(
            (entry) => entry.sequence,
          ),
        ).toEqual([1]);
        expect((yield* boards.readNew("child")).entries.map((entry) => entry.sequence)).toEqual([
          2, 3,
        ]);
        expect((yield* boards.readNew("sibling")).entries.map((entry) => entry.sequence)).toEqual([
          1, 3,
        ]);
        const first = yield* boards.current("child", { limit: 1 });
        expect(first).toMatchObject({ nextAfter: 2, hasMore: true });
        expect(
          (yield* boards.current("child", { after: first.nextAfter })).entries.map(
            (entry) => entry.sequence,
          ),
        ).toEqual([3]);
        yield* boards.recordIntake("child", board.lineageId, [2], "readAt");
        expect((yield* boards.current("child", { topic: "output" })).entries).toMatchObject([
          { sequence: 2, topic: "output", supersedes: [1] },
        ]);
        yield* boards.append("child", {
          audience: "workgroup",
          topic: "output",
          supersedes: [1, 2],
          description: "Shared final output",
          body: "Final contract",
        });
        expect(
          (yield* boards.current("child", { topic: "output" })).entries.map(
            (entry) => entry.sequence,
          ),
        ).toEqual([4]);
        expect(
          (yield* boards.current("sibling", { topic: "output" })).entries.map(
            (entry) => entry.sequence,
          ),
        ).toEqual([4]);
        // The author's own replacement still removes old unread proposals, without notifying itself.
        expect((yield* boards.readNew("child")).entries.map((entry) => entry.sequence)).toEqual([
          3,
        ]);
        expect((yield* boards.read("sibling", [1, 2])).entries.map((entry) => entry.body)).toEqual([
          "Initial contract",
          "Corrected contract",
        ]);
        expect(
          (yield* boards.browse(board.lineageId, {})).entries.map((entry) => entry.sequence),
        ).toEqual([1, 2, 3, 4]);
        expect((yield* boards.entryReceipts("parent", 2)).receipts[0]?.readAt).toEqual(
          expect.any(String),
        );
        expect(yield* (yield* MessageBoardStorage).receipts(board.lineageId)).toHaveLength(1);
      }),
    ),
  );
  it.effect("validates same-topic earlier references atomically without consuming sequences", () =>
    run(
      Effect.gen(function* () {
        yield* boards.ensureBoard(family);
        yield* boards.append("parent", {
          audience: "workgroup",
          topic: "output",
          description: "Initial",
          body: "Evidence",
        });
        for (const relations of [
          { supersedes: [1] },
          { topic: "state", supersedes: [1] },
          { topic: "output", supersedes: [2] },
          { topic: "output", supersedes: [999] },
        ]) {
          const result = yield* Effect.result(
            boards.append("parent", {
              audience: "workgroup",
              description: "Invalid correction",
              body: "Evidence",
              ...relations,
            }),
          );
          expect(result._tag).toBe("Failure");
        }
        const valid = yield* boards.append("child", {
          audience: "workgroup",
          topic: "output",
          supersedes: [1],
          description: "Correction",
          body: "Evidence",
        });
        expect(valid.entry.sequence).toBe(2);
        expect((yield* boards.current("parent")).entries).toMatchObject([
          { sequence: 2, supersedes: [1] },
        ]);
      }),
    ),
  );
  it.effect("keeps independent live proposals in a topic until explicitly superseded", () =>
    run(
      Effect.gen(function* () {
        yield* boards.ensureBoard(family);
        yield* boards.append("parent", {
          audience: "workgroup",
          topic: "output",
          description: "Proposal A",
          body: "A",
        });
        yield* boards.append("child", {
          audience: "workgroup",
          topic: "output",
          description: "Proposal B",
          body: "B",
        });
        expect(
          (yield* boards.current("sibling", { topic: "output" })).entries.map(
            (entry) => entry.sequence,
          ),
        ).toEqual([1, 2]);
        yield* boards.append("parent", {
          audience: "workgroup",
          topic: "output",
          supersedes: [1, 2],
          description: "Decision C",
          body: "C",
        });
        yield* boards.append("child", {
          audience: "workgroup",
          topic: "output",
          supersedes: [3],
          description: "Correction D",
          body: "D",
        });
        expect(
          (yield* boards.current("sibling", { topic: "output" })).entries.map(
            (entry) => entry.sequence,
          ),
        ).toEqual([4]);
      }),
    ),
  );
  it.effect("can organize an untagged finding through a topic-bearing correction", () =>
    run(
      Effect.gen(function* () {
        yield* boards.ensureBoard(family);
        yield* boards.append("parent", {
          audience: "workgroup",
          description: "Initial finding",
          body: "Evidence",
        });
        yield* boards.append("child", {
          audience: "workgroup",
          topic: "output",
          supersedes: [1],
          description: "Organized correction",
          body: "Corrected evidence",
        });
        expect((yield* boards.current("parent", { topic: "output" })).entries).toMatchObject([
          { sequence: 2, topic: "output", supersedes: [1] },
        ]);
        expect((yield* boards.read("parent", [1])).entries[0]?.topic).toBeUndefined();
      }),
    ),
  );
  it.effect("retains topic relationships and current decisions after reacquisition", () =>
    Effect.gen(function* () {
      const harness = messageBoardHarness();
      yield* Effect.gen(function* () {
        yield* boards.ensureBoard(family);
        yield* boards.append("parent", {
          audience: "workgroup",
          topic: "output",
          description: "Initial",
          body: "Initial body",
        });
        yield* boards.append("child", {
          audience: "workgroup",
          topic: "output",
          supersedes: [1],
          description: "Corrected",
          body: "Final body",
        });
      }).pipe(Effect.provide(Layer.merge(harness.layer, familyLayer)));
      yield* Effect.gen(function* () {
        expect((yield* boards.current("parent")).entries).toMatchObject([
          { sequence: 2, topic: "output", supersedes: [1] },
        ]);
        expect((yield* boards.read("parent", [1])).entries[0]?.body).toBe("Initial body");
      }).pipe(Effect.provide(Layer.merge(messageBoardHarness(harness.files).layer, familyLayer)));
    }),
  );
  it.effect("rejects outsiders, invalid audiences, and generic board replacement", () =>
    run(
      Effect.gen(function* () {
        const board = yield* boards.ensureBoard(family);
        expect(
          (yield* Effect.result(
            boards.append("outsider", { audience: "workgroup", description: "Bad", body: "Bad" }),
          ))._tag,
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
        yield* boards.append("parent", {
          audience: "workgroup",
          description: "Persisted",
          body: "Evidence",
        });
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
        audience: "workgroup",
        description: "Discovery",
        body: "Evidence from a separate worktree",
      });
      expect((yield* boards.readNew("root")).entries).toHaveLength(1);
    }).pipe(Effect.provide(Layer.merge(messageBoardHarness().layer, familyStorageHarness().layer))),
  );
});
