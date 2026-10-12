import { Effect } from "effect";
import type { ProjectSessionAgentPolicy } from "../../contracts/project-sessions/project-session-agent-policy";
import type { SessionFamilyStorageError } from "../../contracts/storage/session-family-storage-errors";
import { ProjectSessionError } from "../../contracts/project-sessions/project-session-data";
import {
  SessionFamilyStorage,
  familyChildren,
  familyMember,
} from "../../services/storage/SessionFamilyStorage";

/** Read current membership; this snapshot is not an admission permit. */
export const read: (
  sessionId: string,
) => Effect.Effect<ProjectSessionAgentPolicy, SessionFamilyStorageError, SessionFamilyStorage> =
  Effect.fn("ProjectSessionAgentPolicy.read")(function* (sessionId) {
    const storage = yield* SessionFamilyStorage;
    const family = yield* storage.familyForMember(sessionId);
    if (!family) return { canFork: true, deferResolution: true };
    const member = familyMember(family, sessionId);
    return {
      family: {
        familyId: family.familyId,
        parentSessionId: member?.parentSessionId ?? family.parentSessionId,
        role: member?.parentSessionId === undefined ? "root" : "child",
        childSessionIds: familyChildren(family, sessionId).map((child) => child.sessionId),
      },
      canFork: false,
      deferResolution: false,
    };
  });

/** Agent-only policy; ordinary user forks may still create standalone copies of family members. */
export const assertCanFork: (
  sessionId: string,
) => Effect.Effect<void, ProjectSessionError | SessionFamilyStorageError, SessionFamilyStorage> =
  Effect.fn("ProjectSessionAgentPolicy.assertCanFork")(function* (sessionId) {
    if (!(yield* read(sessionId)).canFork)
      return yield* new ProjectSessionError({
        operation: "fork",
        message: "Session Family members cannot be forked by their agent",
      });
  });
