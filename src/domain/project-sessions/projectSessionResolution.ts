import { Effect } from "effect";
import {
  SessionArchiveStorage,
  type SessionArchiveLocation,
} from "../../services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";

/** Only standalone sessions and family roots own lifecycle state. A child's
 * transcript namespace is a storage detail, never a resolution authority. */
export const resolutionNamespace = Effect.fn("ProjectSessions.resolutionNamespace")(function* (
  sessionId: string,
  location: SessionArchiveLocation,
) {
  const family = yield* (yield* SessionFamilyStorage).familyForMember(sessionId);
  return yield* (yield* SessionArchiveStorage).locate(
    family?.parentSessionId ?? sessionId,
    family ? { ...location, cwd: family.workingDirectory } : location,
  );
});
