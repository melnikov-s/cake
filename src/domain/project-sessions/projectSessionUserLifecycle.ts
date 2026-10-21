import { Effect } from "effect";
import {
  ResolutionRejected,
  ResolutionCleanupFailed,
} from "../../contracts/project-sessions/project-session-resolution";
import {
  ProjectSessionError,
  type ProjectSessionTarget,
} from "../../contracts/project-sessions/project-session-data";
import { SessionFamilyStorage, familyMemberIds } from "../../services/storage/SessionFamilyStorage";
import { lookup } from "./projectSessionMetadata";
import * as lifecycle from "./projectSessionLifecycle";
import { recordSessionChange } from "../projects/projectTodos";

/** Renderer-only intent: native lifecycle remains the sole transition/constraint authority. */
export const setResolved = Effect.fn("ProjectSessions.setResolvedFromUser")(
  function* (target: ProjectSessionTarget, resolved: boolean) {
    const families = yield* SessionFamilyStorage;
    const family = yield* families.familyForMember(target.sessionId);
    const before = yield* Effect.forEach(
      family ? familyMemberIds(family) : [target.sessionId],
      (sessionId) => lookup({ sessionId }),
    );
    const result = yield* (resolved ? lifecycle.resolve(target) : lifecycle.restore(target)).pipe(
      Effect.result,
    );
    // Cleanup can fail after resolution committed. Re-read authority even on typed failure,
    // and never describe an attempted/blocked transition as a user change.
    for (const previous of before) {
      const current = yield* lookup({ sessionId: previous.sessionId });
      if (current.resolved !== previous.resolved)
        yield* recordSessionChange(
          current.projectPath,
          current.sessionId,
          current.title,
          current.resolved,
        );
    }
    if (result._tag === "Failure") return yield* Effect.fail(result.failure);
  },
  Effect.mapError((cause) =>
    cause instanceof ResolutionRejected ||
    cause instanceof ResolutionCleanupFailed ||
    cause instanceof ProjectSessionError
      ? cause
      : new ProjectSessionError({
          operation: "setResolvedFromUser",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
  ),
);
