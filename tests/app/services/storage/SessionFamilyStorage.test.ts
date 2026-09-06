import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { describe } from "vitest";
import { Effect } from "effect";
import { familyStorageHarness } from "../../helpers/familyStorageHarness";
import { SessionFamilyStorage } from "../../../../src/services/storage/SessionFamilyStorage";

const testLayer = () => familyStorageHarness().layer;

const child = (requestId: string, childSessionId: string) => ({
  familyId: crypto.randomUUID(),
  parentSessionId: "parent",
  childSessionId,
  requestId,
  projectPath: "/project",
  workingDirectory: "/project/.cake-worktrees/feature",
  managedWorktreePath: "/project/.cake-worktrees/feature",
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("SessionFamilyStorage", () => {
  it.effect("migrates membership-only storage without losing existing families", () => {
    const files = new Map([
      ["state/session-families.json", JSON.stringify({ version: 1, data: { families: [] } })],
    ]);
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      assert.deepEqual(yield* storage.state(), { families: [], transitions: [], turns: [] });
      yield* storage.addChild(child("request", "child"));
      yield* storage.recordTurn({
        sessionId: "child",
        parentSessionId: "parent",
        turnId: "turn",
        reported: false,
      });
      yield* storage.reportTurns("child", ["turn"]);
      yield* storage.settleTurn("turn", "complete");
      assert.deepEqual((yield* storage.state()).turns, []);
      assert.equal((yield* storage.list()).length, 1);
      assert.equal(JSON.parse(files.get("state/session-families.json") ?? "{}").version, 2);
    }).pipe(Effect.provide(familyStorageHarness(files).layer));
  });

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
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("rejects grandchildren and Working Directory changes", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(child("request-1", "child-1"));
      const grandchildError = yield* Effect.flip(
        storage.addChild({ ...child("request-2", "grandchild"), parentSessionId: "child-1" }),
      );
      assert.match(grandchildError.message, /cannot create children/);
      const movedError = yield* Effect.flip(
        storage.addChild({ ...child("request-3", "child-2"), workingDirectory: "/elsewhere" }),
      );
      assert.match(movedError.message, /cannot change/);
    }).pipe(Effect.provide(testLayer())),
  );
});
