import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import type { ProjectSessionControlInvocation } from "../../../src/domain/project-sessions/project-session-data";
import { PiSessions } from "../../../src/services/pi/PiSessions";
import type { ProjectSessionRuntimeIntegrations } from "../../../src/services/pi/ProjectSessionIntegrationHost";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { makeProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";

const rootId = "root";
const sharedChildId = "shared-child";
const isolatedChildId = "isolated-child";
const grandchildId = "grandchild";
const projectLocation = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  sessionDirectory: "/sessions",
  resolvedSessionDirectory: "/resolved",
};
const isolatedChildPath = "/worktrees/isolated-child";
const grandchildPath = "/worktrees/grandchild";
const worktreeRecords = [
  {
    projectPath: "/project",
    worktreePath: isolatedChildPath,
    branch: "agent/isolated-child",
    baseBranch: "main",
    parentWorktreePath: "/project",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    projectPath: "/project",
    worktreePath: grandchildPath,
    branch: "agent/grandchild",
    baseBranch: "agent/isolated-child",
    parentWorktreePath: isolatedChildPath,
    createdAt: "2026-01-01T00:00:01.000Z",
  },
];

const addFamilyMember = (
  storage: SessionFamilyStorage["Service"],
  childSessionId: string,
  parentSessionId: string,
  parentWorkingDirectory: string,
  childWorkingDirectory: string,
) =>
  storage.addChild({
    familyId: "family",
    parentSessionId,
    childSessionId,
    requestId: `request-${childSessionId}`,
    projectPath: "/project",
    parentWorkingDirectory,
    parentManagedWorktreePath:
      parentWorkingDirectory === "/project" ? undefined : parentWorkingDirectory,
    childWorkingDirectory,
    childManagedWorktreePath:
      childWorkingDirectory === parentWorkingDirectory ? undefined : childWorkingDirectory,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

describe("Project Session runtime worktree controls", () => {
  it.effect("reads current family membership after runtime option acquisition", () => {
    const invocations: ProjectSessionControlInvocation[] = [];
    const integrations: ProjectSessionRuntimeIntegrations = {
      requestUi: async () => undefined,
      requestApplicationControl: async (invocation) => {
        invocations.push(invocation);
        return { ok: true };
      },
      emitExtensionUiIntent: () => undefined,
      persistArtifact: async () => {
        throw new Error("Unexpected artifact persistence");
      },
      requestArtifact: async () => undefined,
      generateInlineWidget: async () => {
        throw new Error("Unexpected widget generation");
      },
      listArtifacts: async () => [],
    };
    const environment = Layer.mergeAll(
      makeProjectSessionRuntimeMechanismTestLayer(integrations),
      familyStorageHarness().layer,
      SessionCatalogChanges.layer,
      Layer.mock(PiSessions, {}),
      Layer.mock(SessionArchiveStorage, {
        locate: () => Effect.succeed("active" as const),
      }),
      Layer.mock(ApplicationState, {
        snapshot: () => ({
          ...defaultApplicationState(),
          projects: [
            {
              path: "/project",
              name: "Project",
              addedAt: "2026-01-01T00:00:00.000Z",
              lastOpenedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          trustedProjectPaths: ["/project", isolatedChildPath],
        }),
      }),
      Layer.mock(ManagedWorktrees, {
        records: () => Effect.succeed(worktreeRecords),
        proposeSquashMessage: () => Effect.void,
      }),
    );

    return Effect.gen(function* () {
      const rootOptions = yield* acquireOptions({
        location: projectLocation,
        sessionId: rootId,
        newSession: false,
      });
      const storage = yield* SessionFamilyStorage;

      yield* addFamilyMember(storage, sharedChildId, rootId, "/project", "/project");
      yield* addFamilyMember(storage, isolatedChildId, rootId, "/project", isolatedChildPath);
      yield* addFamilyMember(
        storage,
        grandchildId,
        isolatedChildId,
        isolatedChildPath,
        grandchildPath,
      );

      const rootControl = rootOptions.runtime.currentSessionControl;
      const rootMerge = rootControl?.mergeSession;
      const rootDiscard = rootControl?.discardSession;
      assert.ok(rootMerge);
      assert.ok(rootDiscard);
      const signal = new AbortController().signal;
      yield* Effect.promise(() => rootMerge(isolatedChildId, signal));
      yield* Effect.promise(() => rootDiscard(isolatedChildId, true, signal));

      yield* Effect.promise(() =>
        assert.rejects(rootMerge(grandchildId, signal), /immediate child of the calling session/),
      );
      yield* Effect.promise(() =>
        assert.rejects(
          rootDiscard(sharedChildId, false, signal),
          /shares its parent's Working Directory/,
        ),
      );

      const childOptions = yield* acquireOptions({
        location: {
          ...projectLocation,
          workingDirectory: isolatedChildPath,
          managedWorktree: worktreeRecords[0],
        },
        sessionId: isolatedChildId,
        newSession: false,
      });
      const childMerge = childOptions.runtime.currentSessionControl?.mergeSession;
      assert.ok(childMerge);
      yield* Effect.promise(() => childMerge(undefined, signal));
      yield* Effect.promise(() =>
        assert.rejects(childMerge(sharedChildId, signal), /immediate child of the calling session/),
      );

      assert.deepEqual(invocations, [
        {
          _tag: "InvokeAppControl",
          command: "worktrees.merge",
          input: { sessionId: isolatedChildId, workingDirectory: isolatedChildPath },
        },
        {
          _tag: "InvokeAppControl",
          command: "worktrees.discard",
          input: {
            sessionId: isolatedChildId,
            workingDirectory: isolatedChildPath,
            keepBranch: true,
          },
        },
        {
          _tag: "InvokeAppControl",
          command: "worktrees.merge",
          input: { sessionId: isolatedChildId, workingDirectory: isolatedChildPath },
        },
      ]);
    }).pipe(Effect.provide(environment));
  });
});
