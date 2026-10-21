import { Effect } from "effect";
import type { AgentControlCaller } from "../application/agentControl";
import type { SessionCompactionResult } from "../../contracts/project-sessions/session-compaction";
import type { ProjectSessionLocation } from "../../contracts/project-sessions/project-session-data";
import {
  CAKE_CHAT_SESSION_ID,
  isCakeChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { ProjectAccess } from "../../services/projects/ProjectAccess";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import * as references from "./sessionReferences";
import * as metadata from "./projectSessionMetadata";
import { acquireMaintenanceTarget } from "./projectSessionOperations";

const compactOne = Effect.fn("SessionCompaction.compactOne")(function* (
  sessionId: string,
  scope: string | undefined,
  global: boolean,
  locations: readonly ProjectSessionLocation[],
  instructions: string | undefined,
) {
  if (!global && !scope)
    return {
      status: "unauthorized" as const,
      message: "The caller has no registered project scope.",
    };
  if (isCakeChatSessionId(sessionId))
    return {
      status: "unavailable" as const,
      message: "Target a Project Session; use context.compact for this permanent chat.",
    };
  const { session, location } = yield* metadata.lookupWithLocation({ sessionId });
  if (
    (!global && session.projectPath !== scope) ||
    !(yield* (yield* ProjectAccess).isAllowed(location.workingDirectory))
  )
    return {
      status: "unauthorized" as const,
      message: "The target is outside the caller's authorized project scope.",
    };
  // Archived routing metadata deliberately omits the Managed Worktree record.
  // Consult the retained registered locations rather than treating that omission
  // as an active checkout (or implicitly restoring it during acquisition).
  const registered = locations.find(
    (item) =>
      item.projectPath === location.projectPath &&
      item.workingDirectory === location.workingDirectory,
  );
  const worktree = registered?.managedWorktree;
  if (
    !registered ||
    (worktree?.state !== undefined && !["active", "landed"].includes(worktree.state))
  )
    return {
      status: "unavailable" as const,
      message:
        "The target worktree is retired or missing; restore it explicitly before compaction.",
    };
  const runtimes = yield* CakeSessionRuntimes;
  const current = yield* runtimes.currentStatus({ ...location, sessionId });
  if (current?.streaming || current?.pending || current?.recoveryIssue)
    return {
      status: "busy" as const,
      message: "Target has active, pending or blocked work; nothing was aborted or queued.",
    };
  const handle = yield* acquireMaintenanceTarget(location, sessionId);
  return yield* handle.compactIfIdle(instructions);
});

/** User-requested maintenance only. No lifecycle transition, message admission or history edits. */
export const compact = Effect.fn("SessionCompaction.compact")(function* (
  targets: readonly string[],
  instructions: string | undefined,
  caller: AgentControlCaller,
) {
  const global = caller.kind === "cake-chat" && caller.sessionId === CAKE_CHAT_SESSION_ID;
  const scope = global
    ? undefined
    : caller.kind === "cake-chat"
      ? (yield* ApplicationState)
          .snapshot()
          .projects.find((project) => projectChatSessionId(project.path) === caller.sessionId)?.path
      : (caller.projectPath ??
        (yield* metadata.lookup({ sessionId: caller.sessionId })).projectPath);
  const roster = yield* references.discover();
  const results: SessionCompactionResult[] = [];
  const firstByIdentity = new Map<string, number>();
  for (const reference of targets) {
    const resolved = yield* references.resolveIn(reference, roster.roster).pipe(Effect.result);
    if (resolved._tag === "Failure") {
      results.push({ reference, status: "invalid", message: resolved.failure.message });
      continue;
    }
    const sessionId = resolved.success;
    const duplicateOf = firstByIdentity.get(sessionId);
    if (duplicateOf !== undefined) {
      const first = results[duplicateOf];
      if (first) results.push({ ...first, reference, duplicateOf });
      continue;
    }
    firstByIdentity.set(sessionId, results.length);
    if (!roster.roster.some((entry) => entry.sessionId === sessionId)) {
      results.push({
        reference,
        sessionId,
        status: "invalid",
        message: "Unknown Project Session identity.",
      });
      continue;
    }
    const draft = roster.drafts.find(
      (draft) => draft.sessionId === sessionId && draft.status !== "activated",
    );
    if (draft) {
      const authorized =
        (global || draft.projectPath === scope) &&
        (yield* (yield* ProjectAccess).isAllowed(draft.workingDirectory));
      results.push({
        reference,
        sessionId,
        status: authorized ? "unavailable" : "unauthorized",
        message: authorized
          ? "A saved draft has no Project Session history to compact."
          : "The target is outside the caller's authorized project scope.",
      });
      continue;
    }
    const outcome = yield* Effect.scoped(
      compactOne(sessionId, scope, global, roster.locations, instructions),
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          status: "failed" as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
    results.push({ reference, sessionId, ...outcome });
  }
  return results;
});
