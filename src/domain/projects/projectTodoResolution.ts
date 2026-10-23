import { Effect, Stream } from "effect";
import { resolveSessionReference } from "../../contracts/project-sessions/session-reference";
import {
  CAKE_CHAT_TODO_SCOPE,
  isCakeChatTodoScope,
  projectTodoSessionIds as workReferences,
  type ProjectTodo,
} from "../../contracts/projects/project-todos";
import { ProjectError } from "../../contracts/projects/project-error";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { sessionDirectoryPath } from "../../services/storage/session-files";
import { SessionFamilyStorage, familyMemberIds } from "../../services/storage/SessionFamilyStorage";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import * as locations from "../project-sessions/projectSessionLocations";
import * as todos from "./projectTodos";

/** Source/message/report links are context, not required work; only session associations count.
 *
 * Metadata only: one resolution-index snapshot and filename-only identity enumeration.
 * Include all projects in suffix ambiguity checks, plus retained resolved identities whose
 * checkout has been retired. Never acquire a runtime or inspect a transcript/catalog.
 * Children inherit their root's resolution, not their own transcript namespace.
 * A Project list counts only its own Project's families; global Cake Chat's list spans projects.
 */
export const join = Effect.fn("ProjectTodos.joinResolution")(
  function* (scope: string, items: readonly ProjectTodo[]) {
    if (!items.some((item) => workReferences(item).length))
      return items.map((item) => ({ item, sessions: [] }));
    const families = (yield* (yield* SessionFamilyStorage).state()).families;
    const configuration = yield* ProjectSessionConfiguration;
    const index = yield* (yield* SessionArchiveStorage).resolutionSnapshot();
    const resolvedIds = new Set(Object.values(index.directories).flat());
    const runtimes = yield* CakeSessionRuntimes;
    const allLocations = yield* locations.locations({ includeInactive: true });
    const present = yield* Effect.forEach(allLocations, (location) =>
      Stream.runCollect(
        runtimes.sessionIds({
          workingDirectory: location.workingDirectory,
          sessionDirectory: location.sessionDirectory,
        }),
      ),
    );
    const roster = [
      ...new Set([...resolvedIds, ...present.flat(), ...families.flatMap(familyMemberIds)]),
    ];
    return items.map((item) => ({
      item,
      sessions: workReferences(item)
        .map((reference) => {
          const identity = resolveSessionReference(reference, roster);
          if (!identity.ok || !roster.includes(identity.sessionId))
            return { sessionId: reference, resolved: null, reason: "Unknown or ambiguous session" };
          const sessionId = identity.sessionId;
          const family = families.find((family) => familyMemberIds(family).includes(sessionId));
          const resolved = family
            ? (isCakeChatTodoScope(scope) || family.projectPath === scope) &&
              (
                index.directories[
                  sessionDirectoryPath({
                    workingDirectory: family.workingDirectory,
                    root: configuration.sessionDirectory,
                  })
                ] ?? []
              ).includes(family.parentSessionId)
            : resolvedIds.has(sessionId);
          return { sessionId, resolved };
        })
        .filter(
          (session, index, sessions) =>
            sessions.findIndex((other) => other.sessionId === session.sessionId) === index,
        ),
    }));
  },
  Effect.mapError(
    (cause) => new ProjectError({ operation: "todoResolution", message: cause.message }),
  ),
);

/** Application policy, including legacy items: completion is monotonic; restore never reopens.
 * Revision checks prevent a join from overwriting a concurrent edit or explicit user closure.
 */
export const completeLinked = Effect.fn("ProjectTodos.completeLinked")(function* (scope: string) {
  const candidates = (yield* todos.list(scope)).items.filter((item) => item.state === "open");
  const joined = yield* join(scope, candidates);
  yield* todos.completeResolved(
    scope,
    joined
      .filter(
        ({ sessions }) =>
          sessions.length > 0 && sessions.every((session) => session.resolved === true),
      )
      .map(({ item }) => item),
  );
});

/** Runs after backend initialization, even when no Project Chat/runtime is loaded. Idempotent
 * repair also covers a process exit between the session authority and the to-do commit.
 */
export const initialize = Effect.fn("ProjectTodos.reconcileOnStartup")(function* () {
  const projects = (yield* ApplicationState).snapshot().projects;
  for (const scope of [...projects.map((project) => project.path), CAKE_CHAT_TODO_SCOPE])
    yield* completeLinked(scope).pipe(
      Effect.catch((cause) =>
        Effect.logWarning(
          "Linked to-do reconciliation failed; retry on next startup or association change",
          cause,
        ),
      ),
    );
});

/** Both UI and tools use this after an actual committed lifecycle transition. Context only;
 * never sends messages, wakes agents, resolves sessions, or acknowledges report receipts.
 * The session's Project list hears every change; global Cake Chat's list only hears about
 * sessions it links, since it spans every project.
 */
export const recordLifecycle = Effect.fn("ProjectTodos.recordLifecycle")(function* (
  projectPath: string,
  sessionId: string,
  resolved: boolean,
) {
  const family = yield* (yield* SessionFamilyStorage).familyForMember(sessionId);
  const members = family ? familyMemberIds(family) : [sessionId];
  for (const scope of [projectPath, CAKE_CHAT_TODO_SCOPE]) {
    const value = yield* todos.list(scope);
    for (const memberId of members) {
      const link = value.items
        .flatMap((item) => item.associations)
        .find((link) => link.kind === "session" && link.sessionId === memberId);
      if (!link && isCakeChatTodoScope(scope)) continue;
      yield* todos.recordSessionChange(scope, memberId, link?.title ?? "Project Session", resolved);
    }
  }
});

/** After a committed resolution: the session's Project list and global Cake Chat's list. */
export const completeLinkedForProject = Effect.fn("ProjectTodos.completeLinkedForProject")(
  function* (projectPath: string) {
    yield* completeLinked(projectPath);
    yield* completeLinked(CAKE_CHAT_TODO_SCOPE);
  },
);
