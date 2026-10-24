import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import * as projects from "../../../src/domain/projects/projects";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { makeProjectAccessLive } from "../../../src/services/projects/ProjectAccessLive";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cake-agent-projects-"));
  await mkdir(join(root, "agents"));
  await mkdir(join(root, "existing"));
  await mkdir(join(root, "worktree"));
  await writeFile(join(root, "file.txt"), "not a directory");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function testLayer(records: () => ReadonlyArray<WorktreeRecord> = () => []) {
  const application = ApplicationState.layer.pipe(
    Layer.provide(
      Layer.mock(ApplicationStorage, {
        load: () =>
          Effect.succeed({
            state: {
              ...defaultApplicationState(),
              projects: [
                {
                  path: join(root, "existing"),
                  name: "Existing",
                  addedAt: "2026-01-01T00:00:00.000Z",
                  lastOpenedAt: "2026-01-01T00:00:00.000Z",
                },
              ],
              trustedProjectPaths: [join(root, "existing")],
            },
            source: "current" as const,
          }),
        save: () => Effect.void,
      }),
    ),
  );
  const foundation = Layer.merge(
    application,
    Layer.mock(ManagedWorktrees, { records: () => Effect.sync(records) }),
  );
  return Layer.mergeAll(
    foundation,
    makeProjectAccessLive({
      projectSessionDirectory: "/sessions",
      resolvedProjectSessionDirectory: "/resolved",
    }).pipe(Layer.provide(foundation)),
  );
}

const initialize = Effect.gen(function* () {
  yield* (yield* ApplicationState).initialize();
});

describe("agent Project registration", () => {
  it.effect("registers an existing directory, authorizes it and publishes the catalog", () =>
    Effect.gen(function* () {
      yield* initialize;
      const path = join(root, "agents");
      const catalog = yield* projects.observeCatalog();
      const updates = yield* catalog.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      const result = yield* projects.addForAgent({ path: `${path}/` });

      expect(result).toMatchObject({
        alreadyRegistered: false,
        project: { path, name: "agents", trusted: false },
      });
      expect(yield* (yield* ProjectAccess).isAllowed(path)).toBe(true);
      expect((yield* projects.listForAgent({})).projects.map((project) => project.path)).toEqual([
        path,
        join(root, "existing"),
      ]);
      const [, replaced] = yield* Fiber.join(updates);
      expect(replaced).toMatchObject({
        _tag: "Event",
        event: { _tag: "Replaced", projects: [{ path, name: "agents" }, { name: "Existing" }] },
      });
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("uses a custom name and is idempotent for registered paths", () =>
    Effect.gen(function* () {
      yield* initialize;
      const path = join(root, "agents");
      expect(yield* projects.addForAgent({ path, name: "Agents zone" })).toMatchObject({
        alreadyRegistered: false,
        project: { path, name: "Agents zone" },
      });
      expect(yield* projects.addForAgent({ path, name: "Ignored" })).toMatchObject({
        alreadyRegistered: true,
        project: { path, name: "Agents zone" },
      });
      expect(yield* projects.addForAgent({ path: join(root, "existing") })).toMatchObject({
        alreadyRegistered: true,
        project: { name: "Existing", trusted: true },
      });
      expect((yield* projects.listForAgent({})).projects).toHaveLength(2);
      expect(yield* projects.listForAgent({ query: "zone", limit: 1 })).toEqual({
        total: 1,
        offset: 0,
        nextOffset: null,
        projects: [{ path, name: "Agents zone", projectChatId: projectChatSessionId(path) }],
      });
      expect(yield* projects.listForAgent({ limit: 1 })).toMatchObject({ total: 2, nextOffset: 1 });
      expect(yield* projects.listForAgent({ limit: 1, offset: 1 })).toMatchObject({
        total: 2,
        nextOffset: null,
      });
      expect(yield* projects.infoForAgent({ path })).toMatchObject({
        project: { path, name: "Agents zone", trusted: false },
      });
      expect(yield* projects.infoForAgent({ path: "/unknown" }).pipe(Effect.exit)).toMatchObject({
        _tag: "Failure",
      });
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("rejects relative, missing, non-directory and managed worktree paths", () =>
    Effect.gen(function* () {
      yield* initialize;
      const failures = yield* Effect.forEach(
        ["relative/agents", join(root, "missing"), join(root, "file.txt"), join(root, "worktree")],
        (path) =>
          Effect.flip(projects.addForAgent({ path })).pipe(Effect.map((error) => error.message)),
      );
      expect(failures).toEqual([
        "Project path must be absolute: relative/agents",
        `No directory exists at ${join(root, "missing")}`,
        `Project path is not a directory: ${join(root, "file.txt")}`,
        `${join(root, "worktree")} is a Cake-managed worktree of the Project ${join(root, "existing")}, not a Project root`,
      ]);
      expect((yield* projects.listForAgent({})).projects).toHaveLength(1);
      expect(yield* (yield* ProjectAccess).isAllowed(join(root, "worktree"))).toBe(false);
    }).pipe(
      Effect.provide(
        testLayer(() => [
          {
            projectPath: join(root, "existing"),
            worktreePath: join(root, "worktree"),
            branch: "feature",
            baseBranch: "main",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
      ),
    ),
  );

  it.effect("renames only registered Projects", () =>
    Effect.gen(function* () {
      yield* initialize;
      expect(
        yield* projects.renameForAgent({ path: join(root, "existing"), name: "Renamed" }),
      ).toMatchObject({ project: { path: join(root, "existing"), name: "Renamed" } });
      expect(
        (yield* Effect.flip(projects.renameForAgent({ path: join(root, "agents"), name: "X" })))
          .message,
      ).toBe(`No registered Project has the exact path ${join(root, "agents")}`);
    }).pipe(Effect.provide(testLayer())),
  );
});
