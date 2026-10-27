import { it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import { expect, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import {
  CAKE_CHAT_REFERENCE,
  CAKE_CHAT_SESSION_ID,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import {
  catalog,
  project,
  resolve,
  resolveIn,
} from "../../../src/domain/project-sessions/sessionReferences";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
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
  const resolvedProjects = vi.fn(() =>
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
      state: () =>
        Effect.succeed({
          families: [
            {
              familyId: "family",
              parentSessionId: parent,
              projectPath: "/project",
              workingDirectory: "/project",
              createdAt: timestamp,
              children: [],
            },
          ],
          spawnedSessions: [],
          turns: [],
        }),
    }),
    Layer.mock(SessionArchiveStorage, {
      resolvedProjects,
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
    resolvedProjects,
    setActiveIds(ids: string[]) {
      activeIds = ids;
    },
    fail() {
      failure = true;
    },
  };
}

it.effect(
  "cheap operation results do not repeatedly discover global archives or directories",
  () => {
    const f = fixture();
    // The inactive session is not in this result, but collides with active's short suffix.
    const value = {
      todo: {
        id: "task",
        associations: [{ kind: "session", sessionId: active, title: "Worker" }],
      },
    };
    const execute = vi.fn(async () => value);
    const registry = new CakeOperationRegistry(
      [
        {
          command: "todos.read",
          topic: "todos",
          summary: "Read a todo",
          inputSchema: Schema.Struct({}),
          examples: [{}],
          result: "Todo",
          execute,
        },
      ],
      (value) => Effect.runPromise(project(value).pipe(Effect.provide(f.layer))),
    );
    return Effect.gen(function* () {
      for (let index = 0; index < 20; index++) {
        const result = yield* Effect.promise(() =>
          registry.invoke(
            { command: "todos.read" },
            { signal: new AbortController().signal, toolCallId: `read-${index}`, runtime: {} },
          ),
        );
        expect(result.details).toMatchObject({ result: value });
        expect(result.text).toContain(active);
      }
      expect(execute).toHaveBeenCalledTimes(20);
      expect(f.resolvedProjects).not.toHaveBeenCalled();
      expect(f.sessionIds).not.toHaveBeenCalled();
    });
  },
);

it.effect("resolves and projects identities without title catalogs or runtime acquisition", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const entries = yield* catalog();
    expect(new Set(entries.map((entry) => entry.sessionId))).toEqual(
      new Set([
        active,
        resolvedInPlace,
        inactive,
        retired,
        parent,
        draft,
        projectChatSessionId("/project"),
      ]),
    );
    expect(f.sessionIds.mock.calls.map(([query]) => query.workingDirectory)).toEqual([
      "/project",
      "/inactive-worktree",
    ]);
    expect(yield* resolve(projectChatSessionId("/project"))).toBe(projectChatSessionId("/project"));
    expect(yield* resolve("112345678")).toBe(active);
    expect(yield* resolve("87654321")).toBe(retired);
    expect(yield* resolve("deadbeef")).toBe(resolvedInPlace);
    expect(yield* resolve("cccccccc")).toBe(draft);
    expect(yield* project({ sessionId: active, childSessionId: inactive, text: active })).toEqual({
      sessionId: active,
      childSessionId: inactive,
      text: active,
    });
    expect(yield* Effect.flip(resolve("12345678"))).toMatchObject({
      message: expect.stringContaining("Ambiguous"),
    });
    expect(yield* Effect.flip(resolve("ffffffff"))).toMatchObject({
      message: expect.stringContaining("Unknown"),
    });
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "uses fresh identity scans across removals and additions, retaining collision checks",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      expect(yield* resolve("112345678")).toBe(active);
      f.setActiveIds([]);
      // Full UUIDs pass through for authoritative lookup; only short references need the roster.
      expect(yield* resolve(active)).toBe(active);
      expect(yield* Effect.flip(resolve("112345678"))).toMatchObject({
        message: expect.stringContaining("Unknown"),
      });
      f.setActiveIds([active, active]);
      expect(yield* resolve("112345678")).toBe(active);
      f.fail();
      expect(yield* resolve(active)).toBe(active);
      expect(yield* Effect.flip(resolve("112345678"))).toMatchObject({
        operation: "sessionReferenceCatalog",
        message: "Cannot list",
      });
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("canonicalUuidResolutionDoesNotEnumerateRoster", () => {
  const f = fixture();
  f.fail();
  return Effect.gen(function* () {
    expect(yield* resolve(active)).toBe(active);
    expect(yield* resolve("01957936-0000-7000-8000-0000FFFFFFFF")).toBe(
      "01957936-0000-7000-8000-0000FFFFFFFF",
    );
    expect(f.sessionIds).not.toHaveBeenCalled();
  }).pipe(Effect.provide(f.layer));
});

it.effect("general projection retains round-trippable identities even when discovery fails", () => {
  const f = fixture();
  f.fail();
  const sessionIds = [
    active,
    inactive, // Collides with active's eight-character suffix.
    retired,
    resolvedInPlace,
    parent,
    draft,
    projectChatSessionId("/project"),
    CAKE_CHAT_SESSION_ID,
  ];
  return Effect.gen(function* () {
    const value = {
      sessionIds,
      parentSessionId: parent,
      audience: [active, CAKE_CHAT_SESSION_ID],
      text: CAKE_CHAT_SESSION_ID,
      messageId: active,
    };
    const projected = yield* project(value);
    expect(projected).toEqual({
      ...value,
      sessionIds: [...sessionIds.slice(0, -1), CAKE_CHAT_REFERENCE],
      audience: [active, CAKE_CHAT_REFERENCE],
    });
    expect(value.sessionIds.at(-1)).toBe(CAKE_CHAT_SESSION_ID);
    const output = Schema.decodeUnknownSync(
      Schema.Struct({ sessionIds: Schema.Array(Schema.String) }),
    )(projected);
    for (const [index, reference] of output.sessionIds.entries())
      expect(yield* resolve(reference)).toBe(sessionIds[index]);
    expect(f.resolvedProjects).not.toHaveBeenCalled();
    expect(f.sessionIds).not.toHaveBeenCalled();
  }).pipe(Effect.provide(f.layer));
});

it.effect("suffixFromAuthorizedRosterResolvesWithoutEnumeration", () => {
  const f = fixture();
  f.fail();
  const roster = [{ sessionId: active }, { sessionId: inactive }];
  return Effect.gen(function* () {
    for (let index = 0; index < 20; index++)
      expect(yield* resolveIn("112345678", roster)).toBe(active);
    expect(yield* Effect.flip(resolveIn("12345678", roster))).toMatchObject({
      message: expect.stringContaining("Ambiguous"),
    });
    expect(yield* Effect.flip(resolveIn("ffffffff", roster))).toMatchObject({
      message: expect.stringContaining("Unknown"),
    });
    expect(f.sessionIds).not.toHaveBeenCalled();
    expect(f.resolvedProjects).not.toHaveBeenCalled();
  }).pipe(Effect.provide(f.layer));
});

it.effect("suffixAmbiguityStillRejected", () => {
  const f = fixture();
  return Effect.gen(function* () {
    expect(yield* Effect.flip(resolve("12345678"))).toMatchObject({
      message: expect.stringContaining("Ambiguous"),
    });
    expect(f.sessionIds).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(f.layer));
});

it.effect("app.state retains canonical pane identities without any global roster I/O", () => {
  const f = fixture();
  f.fail();
  return Effect.gen(function* () {
    const value = {
      ok: true,
      command: "app.state",
      state: {
        selection: { kind: "project-session", sessionId: active },
        sessionLayout: { focusedSessionId: active, panes: [{ sessionId: inactive }] },
        workspaceView: {
          kind: "browser",
          sessionId: active,
          status: "ready",
          url: "https://example.com/",
        },
      },
    };
    expect(yield* project(value)).toEqual(value);
    expect(f.sessionIds).not.toHaveBeenCalled();
  }).pipe(Effect.provide(f.layer));
});

it.effect("does not scan the roster for results containing no session identities", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const value = { text: active, messageId: active };
    expect(yield* project(value)).toEqual(value);
    expect(f.sessionIds).not.toHaveBeenCalled();
  }).pipe(Effect.provide(f.layer));
});
