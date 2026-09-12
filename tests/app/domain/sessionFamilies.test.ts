import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";
import { admitTurn } from "../../../src/domain/session-families/sessionFamilies";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { familyStorageHarness } from "../helpers/familyStorageHarness";

const reservation = {
  familyId: "family",
  parentSessionId: "parent",
  parentWorkingDirectory: "/worktree",
  childSessionId: "child",
  childWorkingDirectory: "/worktree",
  requestId: "request",
  projectPath: "/project",
  createdAt: "2026-09-05",
};
const archiveLocation = { cwd: "/worktree", activeRoot: "/active", resolvedRoot: "/resolved" };

describe("Session Family lifecycle", () => {
  it.effect("records recursive child outcomes for the immediate parent", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(reservation);
      yield* storage.addChild({
        ...reservation,
        parentSessionId: "child",
        parentWorkingDirectory: "/worktree",
        childSessionId: "grandchild",
        requestId: "grandchild-request",
      });
      yield* admitTurn("grandchild", archiveLocation, "grandchild-turn", Effect.void);
      assert.deepEqual((yield* storage.state()).turns, [
        {
          sessionId: "grandchild",
          parentSessionId: "child",
          turnId: "grandchild-turn",
          reported: false,
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          familyStorageHarness().layer,
          Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed("active" as const) }),
        ),
      ),
    ),
  );

  it.effect("rejects admission while a failed transition awaits recovery", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(reservation);
      yield* storage.beginTransition("parent", false);
      const error = yield* Effect.flip(
        admitTurn("child", archiveLocation, "turn", Effect.die("Must not accept")),
      );
      assert.match(error.message, /incomplete lifecycle/);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          familyStorageHarness().layer,
          Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed("active" as const) }),
        ),
      ),
    ),
  );
});
