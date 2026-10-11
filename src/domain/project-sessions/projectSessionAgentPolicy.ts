import { Effect } from "effect";
import type { ProjectSessionAgentPolicy } from "../../contracts/project-sessions/project-session-agent-policy";
import type { SessionFamilyStorageError } from "../../contracts/storage/session-family-storage-errors";
import type { ProjectSessionError } from "../../ipc/project-session-data";
import type { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";

/** Review skeleton: read current membership; never retain this result in runtime options. */
export const read: (
  sessionId: string,
) => Effect.Effect<ProjectSessionAgentPolicy, SessionFamilyStorageError, SessionFamilyStorage> =
  Effect.fn("ProjectSessionAgentPolicy.read")(function* () {
    return yield* Effect.die("Unimplemented review skeleton: ProjectSessionAgentPolicy.read");
  });

/** Agent-only policy; ordinary user forks may still create standalone copies of family members. */
export const assertCanFork: (
  sessionId: string,
) => Effect.Effect<void, ProjectSessionError | SessionFamilyStorageError, SessionFamilyStorage> =
  Effect.fn("ProjectSessionAgentPolicy.assertCanFork")(function* () {
    return yield* Effect.die(
      "Unimplemented review skeleton: ProjectSessionAgentPolicy.assertCanFork",
    );
  });
