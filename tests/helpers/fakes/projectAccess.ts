import { Effect, Layer } from "effect";
import { ProjectAccess, ProjectAccessError } from "../../../src/services/projects/ProjectAccess";

type Service = ProjectAccess["Service"];

/** In-memory access: nothing is allowed until `allow`, and sessions resolve once remembered. */
const neutralProjectAccess = (): Service => {
  const allowed = new Set<string>();
  const sessions = new Map<string, string>();
  return {
    allow: (directory) => Effect.sync(() => void allowed.add(directory)),
    revoke: (directory) => Effect.sync(() => void allowed.delete(directory)),
    isAllowed: (directory) => Effect.sync(() => allowed.has(directory)),
    allowedWorkingDirectories: () => Effect.sync(() => [...allowed]),
    rememberSessionLocation: (directory, sessionId) => {
      const existing = sessions.get(sessionId);
      if (existing && existing !== directory)
        return Effect.fail(
          new ProjectAccessError({
            operation: "rememberSessionLocation",
            message: `Session ID collision detected: ${sessionId}`,
          }),
        );
      return Effect.sync(() => void sessions.set(sessionId, directory));
    },
    forgetSessionLocation: (sessionId) => Effect.sync(() => void sessions.delete(sessionId)),
    forgetWorkingDirectories: (directories) =>
      Effect.sync(() => {
        for (const directory of directories) allowed.delete(directory);
        for (const [sessionId, directory] of sessions)
          if (directories.has(directory)) sessions.delete(sessionId);
      }),
    resolveSessionWorkingDirectory: (sessionId) => {
      const directory = sessions.get(sessionId);
      return directory === undefined
        ? Effect.fail(
            new ProjectAccessError({
              operation: "resolveSessionWorkingDirectory",
              message: `Unknown session: ${sessionId}`,
            }),
          )
        : Effect.succeed(directory);
    },
  };
};

export const fakeProjectAccess = (overrides: Partial<Service> = {}) =>
  Layer.sync(ProjectAccess, () => ProjectAccess.of({ ...neutralProjectAccess(), ...overrides }));
