import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { expect } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import {
  CAKE_CHAT_SESSION_ID,
  cakeChatSideChatSessionId,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import { CAKE_CHAT_TODO_SCOPE } from "../../../src/contracts/projects/project-todos";
import { sessionLink } from "../../../src/contracts/conversations/message-reference";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import * as references from "../../../src/domain/discussion-sessions/discussionSessionReferences";
import { setResolved } from "../../../src/domain/discussion-sessions/discussionSessions";
import * as projectTodos from "../../../src/domain/projects/projectTodos";
import * as worktreeMerges from "../../../src/domain/worktrees/worktreeMerges";
import * as todoControls from "../../../src/domain/projects/projectTodoAssociations";
import { join } from "../../../src/domain/projects/projectTodoResolution";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { CakeChatConfiguration } from "../../../src/services/pi-durable/CakeChatConfiguration";
import {
  DiscussionSessionEnvironment,
  type DiscussionSessionRecord,
} from "../../../src/services/discussion-sessions/DiscussionSessionEnvironment";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { makeSubagentStorageTestLayer } from "../helpers/subagentStorageFixture";
import { familyStorageHarness } from "../helpers/familyStorageHarness";

function fixture(parentSessionId = projectChatSessionId("/project")) {
  const sessionId = cakeChatSideChatSessionId(7, parentSessionId);
  let state: ReturnType<ApplicationState["Service"]["snapshot"]> = {
    ...defaultApplicationState(),
    projects: [
      { path: "/project", name: "Project", addedAt: "2026-01-01", lastOpenedAt: "2026-01-01" },
    ],
  };
  let resolved = false;
  let present = true;
  const lookups: unknown[] = [];
  const worktree = {
    projectPath: "/project",
    worktreePath: "/managed/task",
    branch: "agent/task",
    baseBranch: "main",
    createdAt: "2026-01-01",
    state: "active" as const,
  };
  const record = (): DiscussionSessionRecord => ({
    id: "thread",
    parentSessionId,
    workingDirectory: parentSessionId === CAKE_CHAT_SESSION_ID ? "/home" : "/project",
    sidecarSessionId: sessionId,
    pendingParts: [],
    status: resolved ? "resolved" : "open",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    anchor: {
      path: "Task",
      start: { diffLine: 0 },
      end: { diffLine: 0 },
      selectedText: "Task",
      contextBefore: "",
      contextAfter: "",
      diff: "",
    },
  });
  const layer = Layer.mergeAll(
    familyStorageHarness().layer,
    makeSubagentStorageTestLayer(),
    Layer.succeed(CakeChatConfiguration, {
      location: { workingDirectory: "/home", sessionDirectory: "/cake/chat" },
      agentDirectory: "/cake",
    }),
    Layer.mock(ApplicationState, {
      snapshot: () => state,
      current: () => Effect.succeed(state),
      transact: (transition) =>
        transition(state).pipe(
          Effect.tap((next) =>
            Effect.sync(() => {
              state = next;
            }),
          ),
        ),
    }),
    Layer.mock(DiscussionSessionEnvironment, {
      get: () => Effect.succeed(record()),
      setResolved: (_record, value) =>
        Effect.sync(() => {
          resolved = value;
          return record();
        }),
      list: (workingDirectory, parent) =>
        Effect.sync(() => {
          lookups.push({ workingDirectory, parent });
          return present && parent === parentSessionId ? [record()] : [];
        }),
    }),
    Layer.mock(ManagedWorktrees, { records: () => Effect.succeed([worktree]) }),
    Layer.succeed(ProjectSessionConfiguration, {
      sessionDirectory: "/sessions",
      resolvedSessionDirectory: "/resolved",
      agentDirectory: "/agent",
    }),
    Layer.mock(SessionArchiveStorage, {
      resolvedProjects: () => Stream.empty,
      resolutionSnapshot: () => Effect.succeed({ version: 1 as const, directories: {} }),
    }),
    Layer.mock(CakeSessionRuntimes, { sessionIds: () => Stream.empty }),
  );
  const register = Effect.gen(function* () {
    yield* (yield* SessionFamilyStorage).registerSpawn({
      sessionId,
      projectPath: "/project",
      workingDirectory: worktree.worktreePath,
      requester: { sessionId: parentSessionId, kind: "cake-chat", title: "Chat" },
      title: "Task",
      reportDelivered: false,
      resultDelivery: "notification",
      launchedAt: "2026-01-01",
      handoffSettled: false,
    });
  });
  return {
    layer,
    sessionId,
    record,
    lookups,
    register,
    remove: () => {
      present = false;
    },
  };
}

for (const parent of [CAKE_CHAT_SESSION_ID, projectChatSessionId("/project")]) {
  it.effect(
    `resolves saved ownership and managed execution without a Project catalog (${parent})`,
    () => {
      const f = fixture(parent);
      return Effect.gen(function* () {
        yield* f.register;
        const { reference } = yield* references.lookup(f.sessionId);
        expect(reference).toMatchObject({
          sessionId: f.sessionId,
          parentSessionId: parent,
          executionDirectory: "/managed/task",
          projectPath: "/project",
          resolved: false,
        });
        expect(f.lookups).toEqual([{ workingDirectory: f.record().workingDirectory, parent }]);
        expect(yield* worktreeMerges.resolveSessionWorktree(f.sessionId)).toEqual({
          sessionId: f.sessionId,
          workspacePath: "/managed/task",
        });
        f.remove();
        expect((yield* references.lookup(f.sessionId).pipe(Effect.flip)).message).toContain(
          "could not find Side Chat",
        );
      }).pipe(Effect.provide(f.layer));
    },
  );
}

it.effect(
  "accepts Side Chat work/source links, enforces project scope, and joins Discussion resolution rather than execution completion",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const item = yield* todoControls.create("/project", {
        title: "Recover task",
        description: "Preserve work",
        associations: [
          { kind: "session", sessionId: f.sessionId, title: "Side Chat" },
          { kind: "source", title: "Source", ref: sessionLink(f.sessionId) },
        ],
      });
      expect(item.associations).toHaveLength(2);
      expect((yield* join("/project", [item]))[0]?.sessions).toEqual([
        { sessionId: f.sessionId, resolved: false },
      ]);
      yield* setResolved(
        {
          parentSessionId: f.record().parentSessionId,
          workingDirectory: "/project",
          threadId: "thread",
        },
        true,
      );
      expect(
        (yield* projectTodos.list("/project")).items.find((candidate) => candidate.id === item.id)
          ?.state,
      ).toBe("done");
      expect((yield* join("/project", [item]))[0]?.sessions).toEqual([
        { sessionId: f.sessionId, resolved: true },
      ]);
      const failure = yield* todoControls
        .create("/other", {
          title: "Wrong project",
          description: "No",
          associations: [{ kind: "source", title: "Source", ref: sessionLink(f.sessionId) }],
        })
        .pipe(Effect.flip);
      expect(failure.message).toContain("this Project Chat's project");
      expect(
        (yield* todoControls.create(CAKE_CHAT_TODO_SCOPE, {
          title: "Global source",
          description: "Context only",
          associations: [{ kind: "source", title: "Source", ref: sessionLink(f.sessionId) }],
        })).state,
      ).toBe("open");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("never assigns an ordinary inline Side Chat its parent's worktree", () => {
  const f = fixture();
  return Effect.gen(function* () {
    expect(
      (yield* worktreeMerges.resolveSessionWorktree(f.sessionId).pipe(Effect.flip)).message,
    ).toContain("owns no Cake-managed worktree");
  }).pipe(Effect.provide(f.layer));
});
