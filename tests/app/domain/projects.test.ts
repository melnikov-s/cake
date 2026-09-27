import type * as FileSystemPromises from "node:fs/promises";
import { it } from "@effect/vitest";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";
import { beforeEach, describe, expect, vi } from "vitest";
import * as projects from "../../../src/domain/projects/projects";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import { upsertProject } from "../../../src/domain/application/application";
import type { WorktreeRecord } from "../../../src/domain/worktrees/managed-worktree-data";
import { ArtifactGarbageCollector } from "../../../src/services/artifacts/ArtifactGarbageCollector";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { ProjectSessionRuntimeHost } from "../../../src/services/pi/ProjectSessionRuntimeHost";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { DrawBoardStorage } from "../../../src/services/storage/DrawBoardStorage";
import { ReviewStorage } from "../../../src/services/storage/ReviewStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SubagentCoordinatorLive } from "../../../src/services/subagents/SubagentCoordinator";
import { Terminal } from "../../../src/services/terminal/Terminal";
import { ClientWorkspaces } from "../../../src/services/clients/ClientWorkspaces";
import { ClientWorkspacesLive } from "../../../src/services/clients/ClientWorkspacesLive";
import { PiModels } from "../../../src/services/pi/PiModels";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { makeProjectAccessLive } from "../../../src/services/projects/ProjectAccessLive";
import { ProjectConfiguration } from "../../../src/services/projects/ProjectConfiguration";
import { RewordingRequests } from "../../../src/services/projects/RewordingRequests";
import { RewordingRequestsLive } from "../../../src/services/projects/RewordingRequestsLive";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";

const pi = vi.hoisted(() => ({ inspect: vi.fn(), reword: vi.fn() }));
vi.mock("../../../src/services/pi/PiWorkflows", () => ({
  inspectWorkspace: pi.inspect,
  rewordProjectSelection: pi.reword,
  locateSessionFile: vi.fn(),
  forkSessionToWorkingDirectory: vi.fn(),
}));
// Keep real workspace-selection policy; replace only the OS lookups.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FileSystemPromises>()),
  realpath: async (path: string) => path,
  stat: async () => ({ isDirectory: () => true }),
}));

beforeEach(() => {
  pi.inspect.mockReset().mockReturnValue(Effect.succeed({ trustRequired: true }));
  pi.reword.mockReset().mockReturnValue(Effect.succeed("Project rewrite"));
});

function testLayer(records: ReadonlyArray<WorktreeRecord> = []) {
  const application = ApplicationState.layer.pipe(
    Layer.provide(
      Layer.mock(ApplicationStorage, {
        load: () =>
          Effect.succeed({
            state: {
              ...defaultApplicationState(),
              utilityModel: {
                provider: "fixture",
                modelId: "utility",
                thinkingLevel: "off" as const,
              },
            },
            source: "current" as const,
          }),
        save: () => Effect.void,
      }),
    ),
  );
  const foundation = Layer.merge(
    application,
    Layer.mock(ManagedWorktrees, {
      records: () => Effect.succeed(records),
    }),
  );
  return Layer.mergeAll(
    foundation,
    makeProjectAccessLive({
      projectSessionDirectory: "/sessions",
      resolvedProjectSessionDirectory: "/resolved",
    }).pipe(Layer.provide(foundation)),
    ClientWorkspacesLive,
    RewordingRequestsLive,
    Layer.succeed(ProjectConfiguration, { agentDirectory: "/agent" }),
    Layer.mock(PiModels, { complete: () => Effect.succeed("Generic rewrite") }),
  );
}

const initialize = Effect.gen(function* () {
  yield* (yield* ApplicationState).initialize();
  const access = yield* ProjectAccess;
  yield* access.allow("/project");
  yield* access.allow("/other");
});

describe("portable Project operations", () => {
  it.effect.each([false, true])(
    "removal retires project/worktree associations but preserves other clients (deleteSessions=%s)",
    (deleteSessions) => {
      const stopped: string[] = [];
      const closed: string[] = [];
      const layer = Layer.mergeAll(
        testLayer([
          {
            projectPath: "/project",
            worktreePath: "/worktree",
            branch: "feature",
            baseBranch: "main",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
        Layer.mock(ProjectSessionRuntimeHost, {
          stopWorkingDirectory: (path) =>
            Effect.sync(() => {
              stopped.push(path);
            }),
        }),
        Layer.mock(Terminal, {
          closeWorkingDirectory: (path) =>
            Effect.sync(() => {
              closed.push(path);
            }),
        }),
        Layer.mock(CakeSessionRuntimes, { catalog: () => Stream.empty }),
        Layer.mock(SessionArchiveStorage, { resolvedProjects: () => Stream.empty }),
        Layer.mock(SessionFamilyStorage, {
          list: () => Effect.succeed([]),
          removeProject: () => Effect.void,
        }),
        Layer.mock(ArtifactGarbageCollector, { request: () => Effect.void }),
        Layer.succeed(ProjectSessionConfiguration, {
          agentDirectory: "/agent",
          sessionDirectory: "/sessions",
          resolvedSessionDirectory: "/resolved",
        }),
        SessionCatalogChanges.layer,
        Layer.mock(ArtifactStorage, {}),
        Layer.mock(DrawBoardStorage, {}),
        Layer.mock(ReviewStorage, {
          agentSessionDirectory: () => {
            throw new Error("Unexpected review directory lookup");
          },
          reviewContextPath: () => {
            throw new Error("Unexpected review context lookup");
          },
          discussionParentContextPath: () => {
            throw new Error("Unexpected discussion context lookup");
          },
        }),
        SubagentCoordinatorLive,
      );
      return Effect.gen(function* () {
        yield* initialize;
        yield* upsertProject("/project", "Project");
        yield* upsertProject("/other", "Other");
        const access = yield* ProjectAccess;
        yield* access.allow("/worktree");
        yield* projects.activateWorkingDirectory(7, "/project");
        yield* projects.activateWorkingDirectory(8, "/worktree");
        yield* projects.activateWorkingDirectory(9, "/other");
        const result = yield* projects.remove(7, { path: "/project", deleteSessions });
        expect(closed).toEqual(["/project", "/worktree"]);
        expect(stopped).toEqual(["/project", "/worktree"]);
        expect(yield* access.isAllowed("/project")).toBe(false);
        expect(yield* access.isAllowed("/worktree")).toBe(false);
        expect(yield* access.isAllowed("/other")).toBe(true);
        const workspaces = yield* ClientWorkspaces;
        expect(workspaces.workspaceForConnection(7)).toBeUndefined();
        expect(workspaces.workspaceForConnection(8)).toBeUndefined();
        expect(workspaces.workspaceForConnection(9)).toBe("/other");
        expect(result.state.projects.map((project) => project.path)).toEqual(["/other"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("project_inspection_uses_non_native_connection", () =>
    Effect.gen(function* () {
      yield* initialize;
      const workspaces = yield* ClientWorkspaces;
      const result = yield* projects.inspect(7, { requestId: "inspect", path: "/project" });
      expect(result).toEqual({ requestId: "inspect", path: "/project", trustRequired: true });
      expect(pi.inspect).toHaveBeenCalledWith("/project");
      expect(workspaces.workspaceForConnection(7)).toBe("/project");
      expect(workspaces.workspaceForConnection(8)).toBeUndefined();
      const denied = yield* Effect.flip(
        projects.inspect(7, { requestId: "denied", path: "/unselected" }),
      );
      expect(denied.operation).toBe("authorizeWorkingDirectory");
      expect(pi.inspect).toHaveBeenCalledOnce();
      expect(workspaces.workspaceForConnection(7)).toBe("/project");
      // A denied inspection does not replace the previously correlated request.
      yield* projects.respondTrust(7, { requestId: "inspect", path: "/project", approved: true });
      const trusted = yield* projects.inspect(7, { requestId: "trusted", path: "/project" });
      expect(trusted.trustRequired).toBe(false);
      expect(
        (yield* Effect.flip(
          projects.respondTrust(7, { requestId: "trusted", path: "/project", approved: true }),
        )).operation,
      ).toBe("respondTrust");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("project_trust_response_is_connection_scoped", () =>
    Effect.gen(function* () {
      yield* initialize;
      yield* projects.inspect(7, { requestId: "inspect", path: "/project" });
      const request = { requestId: "inspect", path: "/project", approved: true };
      expect((yield* Effect.flip(projects.respondTrust(8, request))).message).toContain(
        "no longer pending",
      );
      expect(
        (yield* Effect.flip(projects.respondTrust(7, { ...request, path: "/other" }))).message,
      ).toContain("no longer pending");
      expect((yield* ApplicationState).snapshot().trustedProjectPaths).toEqual([]);
      yield* projects.respondTrust(7, request);
      expect((yield* ApplicationState).snapshot().trustedProjectPaths).toEqual(["/project"]);
      expect((yield* Effect.flip(projects.respondTrust(7, request))).message).toContain(
        "no longer pending",
      );
      yield* projects.inspect(8, { requestId: "other", path: "/other" });
      yield* projects.respondTrust(8, { requestId: "other", path: "/other", approved: false });
      expect((yield* ApplicationState).snapshot().trustedProjectPaths).toEqual(["/project"]);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect(
    "reinspection and connection cleanup invalidate only that connection's trust request",
    () =>
      Effect.gen(function* () {
        yield* initialize;
        yield* projects.inspect(7, { requestId: "old", path: "/project" });
        yield* projects.inspect(8, { requestId: "other-client", path: "/project" });
        yield* projects.inspect(7, { requestId: "current", path: "/other" });
        expect(
          (yield* Effect.flip(
            projects.respondTrust(7, { requestId: "old", path: "/project", approved: true }),
          )).operation,
        ).toBe("respondTrust");
        yield* (yield* ProjectAccess).clearOwner(7);
        (yield* ClientWorkspaces).releaseConnection(7);
        expect(
          (yield* Effect.flip(
            projects.respondTrust(7, { requestId: "current", path: "/other", approved: true }),
          )).operation,
        ).toBe("respondTrust");
        yield* projects.respondTrust(8, {
          requestId: "other-client",
          path: "/project",
          approved: true,
        });
        expect((yield* ClientWorkspaces).workspaceForConnection(8)).toBe("/project");
      }).pipe(Effect.provide(testLayer())),
  );

  it.effect("activation retains authorization without requiring a native window", () =>
    Effect.gen(function* () {
      yield* initialize;
      yield* projects.activateWorkingDirectory(7, "/project");
      yield* projects.activateWorkingDirectory(8, "/other");
      const denied = yield* Effect.flip(projects.activateWorkingDirectory(7, "/unselected"));
      expect(denied.operation).toBe("authorizeWorkingDirectory");
      expect((yield* ClientWorkspaces).workspaceForConnection(7)).toBe("/project");
      expect((yield* ClientWorkspaces).workspaceForConnection(8)).toBe("/other");
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("rewording uses only the caller's authorized active workspace", () =>
    Effect.gen(function* () {
      yield* initialize;
      yield* projects.activateWorkingDirectory(7, "/project");
      yield* projects.activateWorkingDirectory(8, "/other");
      const request = { selection: "unclear", prompt: undefined, workspacePath: "/project" };
      expect(yield* projects.rewordComposerSelection(7, request)).toEqual({
        text: "Project rewrite",
      });
      expect(pi.reword).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath: "/project", selection: "unclear" }),
      );
      expect(yield* projects.rewordComposerSelection(8, request)).toEqual({
        text: "Generic rewrite",
      });
      yield* (yield* ProjectAccess).revoke("/project");
      expect(yield* projects.rewordComposerSelection(7, request)).toEqual({
        text: "Generic rewrite",
      });
      expect(pi.reword).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("rewording cancellation stays scoped to the calling connection", () =>
    Effect.gen(function* () {
      yield* initialize;
      yield* projects.activateWorkingDirectory(7, "/project");
      yield* projects.activateWorkingDirectory(8, "/project");
      const started = yield* Queue.unbounded<{ signal: AbortSignal; complete: () => void }>();
      pi.reword.mockImplementation(({ signal }: { signal: AbortSignal }) =>
        Effect.callback<string, Error>((resume) => {
          const abort = () => resume(Effect.fail(new Error("Rewording cancelled")));
          signal.addEventListener("abort", abort, { once: true });
          Queue.offerUnsafe(started, {
            signal,
            complete: () => resume(Effect.succeed("Reworded")),
          });
          return Effect.sync(() => signal.removeEventListener("abort", abort));
        }),
      );
      const request = { selection: "unclear", prompt: undefined, workspacePath: "/project" };
      const first = yield* Effect.forkChild(
        Effect.flip(projects.rewordComposerSelection(7, request)),
      );
      const firstStarted = yield* Queue.take(started);
      const second = yield* Effect.forkChild(projects.rewordComposerSelection(8, request));
      const secondStarted = yield* Queue.take(started);
      yield* (yield* RewordingRequests).disposeOwner(7);
      expect(firstStarted.signal.aborted).toBe(true);
      expect(secondStarted.signal.aborted).toBe(false);
      expect((yield* Fiber.join(first)).message).toBe("Rewording cancelled");
      secondStarted.complete();
      expect(yield* Fiber.join(second)).toEqual({ text: "Reworded" });
      yield* (yield* RewordingRequests).disposeOwner(8);
      expect(secondStarted.signal.aborted).toBe(false);
    }).pipe(Effect.provide(testLayer())),
  );
});
