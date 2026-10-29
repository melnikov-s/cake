import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { expect } from "vitest";
import { configuration } from "../../../src/domain/discussion-sessions/discussionTodos";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { CAKE_CHAT_TODO_SCOPE } from "../../../src/contracts/projects/project-todos";
import * as todos from "../../../src/domain/projects/projectTodos";
import { completeLinked } from "../../../src/domain/projects/projectTodoResolution";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { sessionDirectoryPath } from "../../../src/services/storage/session-files";
import { projectTodoLayer } from "../helpers/projectTodoHarness";
import { makeSubagentStorageTestLayer } from "../helpers/subagentStorageFixture";

const project = "/project";
const sessionId = "00000000-0000-4000-8000-000000000011";
const signal = new AbortController().signal;

it.effect.each([false, true])(
  "shares only the real parent's list immediately and retains revision/lifecycle and parent-input policy (global=%s)",
  (global) => {
    let resolved = false;
    const scope = global ? CAKE_CHAT_TODO_SCOPE : project;
    const otherScope = global ? project : CAKE_CHAT_TODO_SCOPE;
    const parent = global ? CAKE_CHAT_SESSION_ID : projectChatSessionId(project);
    const layer = Layer.mergeAll(
      projectTodoLayer(),
      makeSubagentStorageTestLayer(),
      Layer.mock(SessionFamilyStorage, {
        state: () => Effect.succeed({ families: [], turns: [], spawnedSessions: [] }),
      }),
      Layer.mock(SessionArchiveStorage, {
        resolutionSnapshot: () =>
          Effect.succeed({
            version: 1 as const,
            directories: {
              [sessionDirectoryPath({ workingDirectory: project, root: "/sessions" })]: resolved
                ? [sessionId]
                : [],
            },
          }),
      }),
      Layer.mock(CakeSessionRuntimes, { sessionIds: () => Stream.make(sessionId) }),
      Layer.mock(ManagedWorktrees, { records: () => Effect.succeed([]) }),
      Layer.succeed(ProjectSessionConfiguration, {
        agentDirectory: "/agent",
        sessionDirectory: "/sessions",
        resolvedSessionDirectory: "/resolved",
      }),
    );
    return Effect.gen(function* () {
      const original = yield* todos.create(scope, {
        title: "Discuss options",
        description: "Review design.",
      });
      const other = yield* todos.create(otherScope, {
        title: "Other list",
        description: "Not shared.",
      });
      const linked = yield* todos.create(scope, {
        title: "Implementation",
        description: "Awaiting resolution.",
        associations: [{ kind: "session", sessionId, title: "Required work" }],
      });
      yield* todos.mutateUser(scope, { _tag: "Select", selectedId: original.id });
      const before = yield* todos.list(scope);
      const side = yield* configuration(parent);
      const sibling = yield* configuration(parent);
      if (!side || !sibling) throw new Error("Missing shared to-do capability");
      expect(side.systemPrompt).toContain(original.title);
      expect(side.systemPrompt).not.toContain(other.title);
      const call = <A>(f: () => Promise<A>) =>
        Effect.tryPromise({ try: f, catch: (error) => error });
      expect((yield* call(() => side.projectTodos.list({}, signal))).items).toHaveLength(2);
      yield* call(() =>
        side.projectTodos.update(
          { id: original.id, expectedRevision: 0, description: "Side-chat finding." },
          signal,
        ),
      );
      expect((yield* todos.read(scope, original.id)).description).toBe("Side-chat finding.");
      expect((yield* call(() => sibling.projectTodos.read(original.id, signal))).revision).toBe(1);
      const added = yield* call(() =>
        side.projectTodos.create(
          { title: "New shared discussion", description: "Continue later." },
          signal,
        ),
      );
      expect((yield* todos.read(scope, added.id)).title).toBe("New shared discussion");
      const denied = yield* call(() => side.projectTodos.read(other.id, signal)).pipe(Effect.exit);
      expect(denied._tag).toBe("Failure");
      const stale = yield* call(() =>
        side.projectTodos.update(
          { id: original.id, expectedRevision: 0, description: "Stale edit." },
          signal,
        ),
      ).pipe(Effect.exit);
      expect(stale._tag).toBe("Failure");
      yield* call(() =>
        side.projectTodos.update(
          { id: linked.id, expectedRevision: 0, status: "Awaiting review." },
          signal,
        ),
      );
      expect((yield* todos.read(scope, linked.id)).state).toBe("open");
      const after = yield* todos.list(scope);
      expect(after.selectedId).toBe(original.id);
      expect(after.pending).toEqual(before.pending);
      expect(after.deliveryToken).toBe(before.deliveryToken);
      resolved = true;
      yield* completeLinked(scope);
      expect((yield* call(() => side.projectTodos.read(linked.id, signal))).completion?.by).toBe(
        "sessions",
      );
      expect((yield* todos.list(scope)).pending).toEqual(
        expect.arrayContaining([...before.pending]),
      );
      const prepared = yield* todos.prepareForChat(parent, "Continue");
      expect(prepared.selection?.id).toBe(original.id);
      yield* todos.consumeSelection(prepared);
      expect((yield* todos.list(scope)).selectedId).toBeNull();
      expect(yield* todos.read(otherScope, other.id)).toEqual(other);
      expect(yield* configuration(sessionId)).toBeUndefined();
    }).pipe(Effect.provide(layer));
  },
);
