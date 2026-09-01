import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";
import { defaultApplicationState } from "../../../../src/domain/application-data";
import { makeProjectAccessLive } from "../../../../src/services/projects/ProjectAccessLive";
import { ProjectAccess } from "../../../../src/services/projects/ProjectAccess";
import { ApplicationState } from "../../../../src/services/storage/ApplicationState";
import { ManagedWorktrees } from "../../../../src/services/worktrees/ManagedWorktrees";

const live = makeProjectAccessLive({
  projectSessionDirectory: "/sessions",
  resolvedProjectSessionDirectory: "/resolved-sessions",
}).pipe(
  Layer.provide(
    Layer.merge(
      Layer.mock(ApplicationState, { snapshot: defaultApplicationState }),
      Layer.mock(ManagedWorktrees, { records: () => Effect.succeed([]) }),
    ),
  ),
);

describe("ProjectAccess", () => {
  it.effect("authorizes Working Directories and resolves remembered Session locations", () =>
    Effect.gen(function* () {
      const access = yield* ProjectAccess;
      yield* access.allow("/project-worktree");
      yield* access.rememberSessionLocation("/project-worktree", "session-1");
      assert.equal(yield* access.isAllowed("/project-worktree"), true);
      assert.equal(yield* access.resolveSessionWorkingDirectory("session-1"), "/project-worktree");
      yield* access.revoke("/project-worktree");
      assert.equal(yield* access.isAllowed("/project-worktree"), false);
    }).pipe(Effect.provide(live)),
  );

  it.effect("rejects Session identity collisions", () =>
    Effect.gen(function* () {
      const access = yield* ProjectAccess;
      yield* access.rememberSessionLocation("/first", "session-1");
      const error = yield* Effect.flip(access.rememberSessionLocation("/second", "session-1"));
      assert.equal(error._tag, "ProjectAccessError");
      assert.match(error.message, /collision/);
    }).pipe(Effect.provide(live)),
  );

  it.effect("scopes pending trust requests to one renderer owner", () =>
    Effect.gen(function* () {
      const access = yield* ProjectAccess;
      yield* access.requestTrust(7, "old", "/first");
      yield* access.requestTrust(7, "current", "/second");
      yield* access.consumeTrustRequest(7, "current", "/second");
      const stale = yield* Effect.flip(access.consumeTrustRequest(7, "old", "/first"));
      assert.equal(stale._tag, "ProjectAccessError");
    }).pipe(Effect.provide(live)),
  );
});
