import { Effect, Stream } from "effect";
import { parseSessionLink } from "../../contracts/conversations/message-reference";
import { resolveSessionReference } from "../../contracts/project-sessions/session-reference";
import type { ProjectTodo } from "../../contracts/projects/project-todos";
import { ProjectError } from "../../contracts/projects/project-error";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { sessionDirectoryPath } from "../../services/storage/session-files";
import { SessionFamilyStorage, familyMemberIds } from "../../services/storage/SessionFamilyStorage";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import * as locations from "../project-sessions/projectSessionLocations";
import * as todos from "./projectTodos";

/** Session/message/report links are work. Other source links are supporting context, not blockers. */
const workReferences = (item: ProjectTodo) => [
  ...new Set(
    item.associations.flatMap((link) => {
      const id = link.kind === "session" ? link.sessionId : parseSessionLink(link.ref)?.sessionId;
      return id ? [id] : [];
    }),
  ),
];

/** One family snapshot and one resolution-index read for the whole page.
 * Filenames establish unresolved identity, once per Project directory, not per item.
 * Never calls catalog, inspect, runtime acquisition, archive migration, or per-session metadata.
 * Index entries retain resolved identities even after their worktree is retired. */
export const join = Effect.fn("ProjectTodos.joinResolution")(
  function* (projectPath: string, items: readonly ProjectTodo[]) {
    if (!items.some((item) => workReferences(item).length))
      return items.map((item) => ({ item, sessions: [] }));
    const families = (yield* (yield* SessionFamilyStorage).state()).families.filter(
      (family) => family.projectPath === projectPath,
    );
    const configuration = yield* ProjectSessionConfiguration;
    const index = yield* (yield* SessionArchiveStorage).resolutionSnapshot();
    const resolvedIds = new Set(Object.values(index.directories).flat());
    const runtimes = yield* CakeSessionRuntimes;
    const projectLocations = (yield* locations.locations({ includeInactive: true })).filter(
      (location) => location.projectPath === projectPath,
    );
    const present = yield* Effect.forEach(projectLocations, (location) =>
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
            ? (
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

/** Only an actual resolve invokes this. Historical/manual items need explicit revision-checked adoption. */
export const completeLinked = Effect.fn("ProjectTodos.completeLinked")(function* (
  projectPath: string,
) {
  const candidates = (yield* todos.list(projectPath)).items.filter(
    (item) => item.state === "open" && item.completionPolicy === "linked",
  );
  const joined = yield* join(projectPath, candidates);
  yield* todos.completeResolved(
    projectPath,
    joined
      .filter(
        ({ sessions }) =>
          sessions.length > 0 && sessions.every((session) => session.resolved === true),
      )
      .map(({ item }) => item),
  );
});
