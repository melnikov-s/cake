import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { expect, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { catalog, project, resolve } from "../../../src/domain/project-sessions/sessionReferences";
import { CakeSessionRuntimes, PiSessionError } from "../../../src/services/pi/CakeSessionRuntimes";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SavedDraftStorage } from "../../../src/services/storage/SavedDraftStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";

const active = "01957936-0000-7000-8000-000112345678";
const inactive = "01957936-0000-7000-8000-000212345678";
const retired = "01957936-0000-7000-8000-000087654321";
const resolvedInPlace = "01957936-0000-7000-8000-0000deadbeef";
const parent = "01957936-0000-7000-8000-0000abcdefab";
const draft = "01957936-0000-4000-8000-0000cccccccc";
const timestamp = "2026-01-01T00:00:00.000Z";

function fixture() {
  // Pi filenames include both active and resolved-in-place sessions.
  let activeIds = [active, resolvedInPlace];
  let failure = false;
  const sessionIds = vi.fn((query: { workingDirectory: string }) =>
    failure
      ? Stream.fail(new PiSessionError({ operation: "sessionIds", message: "Cannot list" }))
      : Stream.fromIterable(query.workingDirectory === "/project" ? activeIds : [inactive]),
  );
  const layer = Layer.mergeAll(
    Layer.mock(ApplicationState, {
      snapshot: () => ({
        ...defaultApplicationState(),
        projects: [
          { path: "/project", name: "Project", addedAt: timestamp, lastOpenedAt: timestamp },
        ],
      }),
    }),
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: "/agent",
      sessionDirectory: "/sessions",
      resolvedSessionDirectory: "/resolved",
    }),
    Layer.mock(ManagedWorktrees, {
      records: () =>
        Effect.succeed([
          {
            worktreePath: "/inactive-worktree",
            projectPath: "/project",
            branch: "agent/inactive",
            baseBranch: "main",
            createdAt: timestamp,
            state: "discarded" as const,
          },
        ]),
    }),
    Layer.mock(SessionFamilyStorage, {
      list: () =>
        Effect.succeed([
          {
            familyId: "family",
            parentSessionId: parent,
            projectPath: "/project",
            workingDirectory: "/project",
            createdAt: timestamp,
            children: [],
          },
        ]),
    }),
    Layer.mock(SessionArchiveStorage, {
      resolvedProjects: () =>
        Stream.succeed({
          version: 2 as const,
          sessionId: retired,
          projectPath: "/project",
          projectName: "Project",
          workingDirectory: "/deleted-worktree",
          activeRoot: "/sessions",
          resolvedRoot: "/resolved",
          createdAt: timestamp,
          modifiedAt: timestamp,
        }),
      // Title-bearing resolved() and Pi catalog() deliberately remain unimplemented.
      // Layer.mock defects if reference resolution tries to open either catalog.
    }),
    Layer.mock(SavedDraftStorage, {
      list: () =>
        Effect.succeed([
          {
            sessionId: draft,
            projectPath: "/project",
            title: "Draft",
            revision: 1,
            status: "saved" as const,
            text: "Next task",
            attachments: [],
            labelIds: [],
            resolved: false,
            workingDirectory: "/project",
            createdAt: timestamp,
            modifiedAt: timestamp,
          },
        ]),
    }),
    Layer.mock(CakeSessionRuntimes, { sessionIds }),
  );
  return {
    layer,
    sessionIds,
    setActiveIds(ids: string[]) {
      activeIds = ids;
    },
    fail() {
      failure = true;
    },
  };
}

it.effect("resolves and projects identities without title catalogs or runtime acquisition", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const entries = yield* catalog();
    expect(new Set(entries.map((entry) => entry.sessionId))).toEqual(
      new Set([active, resolvedInPlace, inactive, retired, parent, draft]),
    );
    expect(f.sessionIds.mock.calls.map(([query]) => query.workingDirectory)).toEqual([
      "/project",
      "/inactive-worktree",
    ]);
    expect(yield* resolve("s:112345678")).toBe(active);
    expect(yield* resolve("s:87654321")).toBe(retired);
    expect(yield* resolve("s:deadbeef")).toBe(resolvedInPlace);
    expect(yield* resolve("s:cccccccc")).toBe(draft);
    expect(yield* project({ sessionId: active, childSessionId: inactive, text: active })).toEqual({
      sessionId: "s:112345678",
      childSessionId: "s:212345678",
      text: active,
    });
    expect(yield* Effect.flip(resolve("s:12345678"))).toMatchObject({
      message: expect.stringContaining("Ambiguous"),
    });
    expect(yield* Effect.flip(resolve("s:ffffffff"))).toMatchObject({
      message: expect.stringContaining("Unknown"),
    });
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "uses fresh identity scans across removals and additions, retaining collision checks",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      expect(yield* resolve(active)).toBe(active);
      f.setActiveIds([]);
      expect(yield* Effect.flip(resolve(active))).toMatchObject({
        message: expect.stringContaining("Unknown"),
      });
      f.setActiveIds([active, active]);
      expect(yield* resolve("s:112345678")).toBe(active);
      f.fail();
      expect(yield* Effect.flip(resolve(active))).toMatchObject({
        operation: "sessionReferenceCatalog",
        message: "Cannot list",
      });
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("does not scan the roster for results containing no session identities", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const value = { text: active, messageId: active };
    expect(yield* project(value)).toBe(value);
    expect(f.sessionIds).not.toHaveBeenCalled();
  }).pipe(Effect.provide(f.layer));
});
