import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { describe } from "vitest";
import { admitTurn, transition } from "../../../src/domain/sessionFamilies";
import { PiSessions } from "../../../src/services/pi/PiSessions";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { familyStorageHarness } from "../helpers/familyStorageHarness";

const reservation = {
  familyId: "family",
  parentSessionId: "parent",
  childSessionId: "child",
  requestId: "request",
  projectPath: "/project",
  workingDirectory: "/worktree",
  createdAt: "2026-09-05",
};
const archiveLocation = { cwd: "/worktree", activeRoot: "/active", resolvedRoot: "/resolved" };

describe("Session Family lifecycle", () => {
  it.effect("retains a partial archive journal and completes it after storage reload", () => {
    const harness = familyStorageHarness();
    const moved = new Set<string>();
    const pi = Layer.mock(PiSessions, { currentStatus: () => Effect.succeed(undefined) });
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        const family = yield* storage.addChild(reservation);
        const error = yield* Effect.flip(
          transition(family, true, "/active", (id) =>
            id === "child"
              ? Effect.fail("disk failure")
              : Effect.sync(() => {
                  moved.add(id);
                }),
          ),
        );
        assert.equal(error, "disk failure");
        assert.deepEqual([...moved], ["parent"]);
        assert.deepEqual((yield* storage.state()).transitions, [
          { parentSessionId: "parent", resolved: true },
        ]);
      }).pipe(Effect.provide(harness.layer));
      yield* Effect.gen(function* () {
        const storage = yield* SessionFamilyStorage;
        const family = (yield* storage.list())[0];
        assert.ok(family);
        yield* transition(family, true, "/active", (id) =>
          Effect.sync(() => {
            moved.add(id);
          }),
        );
        assert.deepEqual([...moved], ["parent", "child"]);
        assert.deepEqual((yield* storage.state()).transitions, []);
      }).pipe(Effect.provide(familyStorageHarness(harness.files).layer));
    }).pipe(Effect.provide(pi));
  });

  it.effect("does not admit a turn between the idle check and archival", () => {
    const namespaces = new Map<string, "active" | "resolved">([
      ["parent", "active"],
      ["child", "active"],
    ]);
    return Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      const family = yield* storage.addChild(reservation);
      const moving = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const attempted = yield* Deferred.make<void>();
      let admitted = false;
      const archive = yield* transition(family, true, "/active", (id) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(moving, undefined);
          yield* Deferred.await(release);
          namespaces.set(id, "resolved");
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(moving);
      const prompt = yield* Effect.gen(function* () {
        yield* Deferred.succeed(attempted, undefined);
        return yield* Effect.flip(
          admitTurn(
            "child",
            archiveLocation,
            "turn",
            Effect.sync(() => {
              admitted = true;
            }),
          ),
        );
      }).pipe(Effect.forkChild);
      yield* Deferred.await(attempted);
      assert.equal(admitted, false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(archive);
      const error = yield* Fiber.join(prompt);
      assert.match(error.message, /Restore the family/);
      assert.equal(admitted, false);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          familyStorageHarness().layer,
          Layer.mock(PiSessions, { currentStatus: () => Effect.succeed(undefined) }),
          Layer.mock(SessionArchiveStorage, { locate: (id) => Effect.succeed(namespaces.get(id)) }),
        ),
      ),
    );
  });

  it.effect("rejects resolution when work was already admitted", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      const family = yield* storage.addChild(reservation);
      const error = yield* Effect.flip(
        transition(family, true, "/active", () => Effect.die("Must not archive")),
      );
      assert.match(error.message, /active or has pending input/);
      assert.deepEqual((yield* storage.state()).transitions, []);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          familyStorageHarness().layer,
          Layer.mock(PiSessions, {
            currentStatus: () =>
              Effect.succeed({ streaming: false, pending: true, persisted: true }),
          }),
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
