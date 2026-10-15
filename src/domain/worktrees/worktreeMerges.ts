import { Effect, Option, Stream, SubscriptionRef, type Duration } from "effect";
import {
  WorktreeLandingError,
  type WorktreeLandingOperation,
} from "../../contracts/worktrees/worktree-landing-data";
import { SessionFamilyStorage, familyMember } from "../../services/storage/SessionFamilyStorage";
import { findLocation } from "../project-sessions/projectSessionMetadata";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";
import { WorktreeLandingCoordinator } from "../../services/worktrees/WorktreeLandingCoordinator";
import * as worktreeLandings from "./worktreeLandings";

/**
 * Agent-facing outcome of Cake's normal Managed Worktree merge workflow.
 *
 * - `landed`: the worktree branch is now contained in its target branch.
 * - `awaiting-agent`: Cake prompted the owning session to commit, resolve conflicts, or
 *   propose a squash message; the landing resumes automatically after that turn.
 * - `stalled`: the owning session's turn ended but the worktree is still blocked.
 * - `failed`: the landing stopped with an error.
 * - `in-progress`: still queued behind another landing or running when the wait ended.
 * - `canceled`: the landing was canceled or replaced, for example from the Cake UI.
 */
type WorktreeMergeOutcome =
  | "landed"
  | "awaiting-agent"
  | "stalled"
  | "failed"
  | "in-progress"
  | "canceled";

interface WorktreeMergeReport {
  command: "worktrees.merge";
  outcome: WorktreeMergeOutcome;
  operationId: string;
  sessionId: string;
  workingDirectory: string;
  phase?: WorktreeLandingOperation["phase"];
  targetBranch?: string;
  landedCommit?: string;
  conflictFiles?: ReadonlyArray<string>;
  pauseReason?: NonNullable<WorktreeLandingOperation["pauseReason"]>;
  error?: string;
  worktreeState?: string;
  nextStep: string;
}

const agentPhases: ReadonlySet<WorktreeLandingOperation["phase"]> = new Set([
  "committing",
  "resolving",
  "resolving-rebase",
  "proposing",
]);
const finalPhases: ReadonlySet<WorktreeLandingOperation["phase"]> = new Set([
  "landed",
  "complete",
  "failed",
  "stalled",
]);
const isTerminal = (operation: WorktreeLandingOperation) =>
  operation.phase === "landed" || operation.phase === "complete" || operation.phase === "failed";

const requestedWork = (operation: WorktreeLandingOperation, owner: "its" | "your") => {
  const files = operation.conflictFiles?.length ? ` (${operation.conflictFiles.join(", ")})` : "";
  switch (operation.pauseReason) {
    case "commit":
      return `commit ${owner} uncommitted worktree changes`;
    case "squash-message":
      return "propose the squash commit message";
    case "rebase-conflict":
      return `resolve rebase conflicts${files} in ${owner} worktree`;
    default:
      return `resolve merge conflicts${files} in ${owner} worktree and commit the resolution`;
  }
};

function nextStep(
  outcome: WorktreeMergeOutcome,
  operation: WorktreeLandingOperation | undefined,
  input: { readonly callerSessionId?: string; readonly targetBranch?: string },
) {
  const target = input.targetBranch ?? "the target branch";
  const never =
    "Never land this work by hand with git merge, cherry-pick, or commit in the target checkout.";
  switch (outcome) {
    case "landed":
      return operation?.landedCommit
        ? `Landed on ${target} at ${operation.landedCommit}. The worktree is marked landed but its session is not resolved; resolve it only when the user asks.`
        : `Nothing new to land: ${target} already contains this worktree's commits. The session is not resolved.`;
    case "awaiting-agent": {
      if (operation && operation.sessionId === input.callerSessionId)
        return `Cake queued a follow-up turn asking you to ${requestedWork(operation, "your")}. Finish this turn now; Cake continues the landing automatically after that turn and retries the merge. ${never}`;
      const work = operation
        ? requestedWork(operation, "its")
        : "finish the requested landing step";
      return `Cake prompted the owning session (${operation?.sessionId ?? "unknown"}) to ${work}. The landing resumes automatically when that turn finishes; call worktrees.merge again later to read the result. ${never}`;
    }
    case "stalled":
      return `The owning session's turn ended but the worktree is still blocked (${operation?.pauseReason ?? "unknown"}). The owning session must finish that work inside its worktree (commit changes or resolve and commit conflicts); then call worktrees.merge again to retry. ${never}`;
    case "failed":
      return `The landing failed: ${operation?.error ?? "unknown error"}. Fix the cause (for example, uncommitted changes in the target checkout belong to the user to commit or stash), then call worktrees.merge again. ${never}`;
    case "in-progress":
      return `The landing is still ${operation?.phase ?? "running"} (Cake serializes landings per repository). Call worktrees.merge again to check; do not start a manual merge. ${never}`;
    case "canceled":
      return "The landing was canceled or replaced, for example from the Cake UI. Call worktrees.merge again only if the user still wants this work landed.";
  }
}

const outcomeOf = (operation: WorktreeLandingOperation | undefined): WorktreeMergeOutcome => {
  if (!operation) return "canceled";
  if (operation.phase === "landed" || operation.phase === "complete") return "landed";
  if (operation.phase === "failed") return "failed";
  if (operation.phase === "stalled") return "stalled";
  if (agentPhases.has(operation.phase)) return "awaiting-agent";
  return "in-progress";
};

/**
 * Start (or retry, or observe) Cake's normal preserve-commits merge workflow for one Managed
 * Worktree and wait until it lands, fails, or needs its owning agent. This is the same
 * landing path as the Merge action in the Cake UI: it commits uncommitted work through the
 * owning session, serializes through the repository landing queue, prompts the owning session
 * to resolve conflicts, and marks the worktree landed without resolving its session.
 */
export const merge = Effect.fn("WorktreeMerges.merge")(function* (input: {
  readonly sessionId: string;
  readonly workspacePath: string;
  /** The session invoking the merge, used to tell an owner to end its own turn. */
  readonly callerSessionId?: string;
  readonly timeout?: Duration.Input;
}) {
  const coordinator = yield* WorktreeLandingCoordinator;
  const existing = (yield* SubscriptionRef.get(coordinator.state)).operations.get(
    input.workspacePath,
  );
  let operationId: string;
  let claimed: WorktreeLandingOperation | undefined;
  if (existing?.phase === "stalled") {
    claimed = yield* worktreeLandings.retry({
      workspacePath: input.workspacePath,
      sessionId: existing.sessionId,
    });
    operationId = claimed.operationId;
  } else if (existing && !isTerminal(existing)) {
    operationId = existing.operationId;
  } else {
    operationId = crypto.randomUUID();
    yield* worktreeLandings.start({
      operationId,
      workspacePath: input.workspacePath,
      sessionId: input.sessionId,
      strategy: "preserve",
      allowDirtyTarget: false,
      commitBeforeLanding: true,
      resolveAfterLanding: false,
    });
  }
  const observed = yield* SubscriptionRef.changes(coordinator.state).pipe(
    Stream.map((state) => state.operations.get(input.workspacePath)),
    // A retry's claimed snapshot predates its worker; wait for the worker's first transition.
    Stream.filter(
      (operation) =>
        operation?.operationId !== operationId ||
        (operation !== claimed &&
          (finalPhases.has(operation.phase) || agentPhases.has(operation.phase))),
    ),
    Stream.runHead,
    Effect.timeoutOption(input.timeout ?? "2 minutes"),
  );
  const latest = (yield* SubscriptionRef.get(coordinator.state)).operations.get(
    input.workspacePath,
  );
  const operation = Option.match(Option.flatten(observed), {
    onNone: () => (latest?.operationId === operationId ? latest : undefined),
    onSome: (value) => (value?.operationId === operationId ? value : undefined),
  });
  const timedOut = Option.isNone(observed) && operation !== undefined;
  const outcome =
    timedOut && !agentPhases.has(operation.phase) ? "in-progress" : outcomeOf(operation);
  const worktrees = yield* ManagedWorktrees;
  const status = yield* worktrees
    .status(input.workspacePath)
    .pipe(Effect.catch(() => Effect.succeed(undefined)));
  const record =
    status?.record ??
    (yield* worktrees.records().pipe(Effect.catch(() => Effect.succeed([])))).find(
      (candidate) => candidate.worktreePath === input.workspacePath,
    );
  const targetBranch = status?.targetBranch ?? record?.baseBranch;
  const report: WorktreeMergeReport = {
    command: "worktrees.merge",
    outcome,
    operationId,
    sessionId: operation?.sessionId ?? input.sessionId,
    workingDirectory: input.workspacePath,
    nextStep: nextStep(outcome, operation, {
      callerSessionId: input.callerSessionId,
      targetBranch,
    }),
  };
  if (operation) report.phase = operation.phase;
  if (targetBranch) report.targetBranch = targetBranch;
  if (operation?.landedCommit) report.landedCommit = operation.landedCommit;
  if (operation?.conflictFiles?.length) report.conflictFiles = operation.conflictFiles;
  if (operation?.pauseReason) report.pauseReason = operation.pauseReason;
  if (operation?.error) report.error = operation.error;
  if (record?.state) report.worktreeState = record.state;
  return report;
});

const targetError = (message: string) =>
  new WorktreeLandingError({ operation: "resolveMergeTarget", message });

/**
 * Resolve any Project Session to the Managed Worktree it owns. A Session Family child that
 * shares its parent's Working Directory owns no worktree; its parent must be merged instead.
 */
export const resolveSessionWorktree = Effect.fn("WorktreeMerges.resolveSessionWorktree")(function* (
  sessionId: string,
) {
  const location = yield* findLocation({ sessionId }).pipe(
    Effect.mapError((cause) => targetError(cause.message)),
  );
  if (!location.managedWorktree)
    return yield* targetError(
      "That session works in the project root, not an isolated Cake-managed worktree, so there is nothing to merge.",
    );
  const family = yield* (yield* SessionFamilyStorage)
    .familyForMember(sessionId)
    .pipe(Effect.mapError((cause) => targetError(cause.message)));
  const member = family && familyMember(family, sessionId);
  const parent =
    family && member?.parentSessionId ? familyMember(family, member.parentSessionId) : undefined;
  if (parent && parent.workingDirectory === location.workingDirectory)
    return yield* targetError(
      `That session shares its parent's Working Directory; merge the parent session ${parent.sessionId} instead.`,
    );
  return { sessionId, workspacePath: location.workingDirectory };
});
