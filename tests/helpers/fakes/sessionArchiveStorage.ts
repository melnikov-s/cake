import { Effect, Layer, Stream } from "effect";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";

type Service = SessionArchiveStorage["Service"];

/** An empty archive: nothing is located or resolved, and mutations have nothing to move. */
const neutralSessionArchiveStorage = (): Service => ({
  relocate: () => Effect.void,
  resolve: () => Effect.succeed(false),
  restore: () => Effect.succeed(false),
  deleteResolved: () => Effect.void,
  deleteAuxiliary: () => Effect.void,
  delete: () => Effect.void,
  locate: () => Effect.succeed(undefined),
  locateMany: () => Effect.succeed(new Set<string>()),
  resolutionSnapshot: () => Effect.succeed({ version: 1 as const, directories: {} }),
  recordedResolvedIds: () => Effect.succeed(new Set<string>()),
  resolvedIds: () => Effect.succeed(new Set<string>()),
  resolved: () => Stream.empty,
  resolvedEntry: () => Effect.succeed(undefined),
  resolveProject: () => Effect.succeed(false),
  restoreProject: () => Effect.succeed(undefined),
  deleteResolvedProject: () => Effect.void,
  resolvedProjects: () => Stream.empty,
  projectTitles: () => Effect.succeed(new Map<string, string>()),
  projectMigrationComplete: () => Effect.succeed(true),
  migrateProject: () => Stream.empty,
  resolvedProjectEntry: () => Effect.succeed(undefined),
});

export const fakeSessionArchiveStorage = (overrides: Partial<Service> = {}) =>
  Layer.succeed(
    SessionArchiveStorage,
    SessionArchiveStorage.of({ ...neutralSessionArchiveStorage(), ...overrides }),
  );
