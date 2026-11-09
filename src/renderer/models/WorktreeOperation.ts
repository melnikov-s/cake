import { Model, id } from "r-state-tree";
import type {
  WorktreeLandingPhase,
  WorktreeLandingOperation,
} from "../../contracts/worktrees/worktree-landing-data";

/** Passive process-lifetime projection of one main-owned landing operation. */
export class WorktreeOperation extends Model {
  operationId = "";
  @id workspacePath = "";
  sessionId = "";
  kind: WorktreeLandingOperation["kind"] = "landing";
  phase: WorktreeLandingPhase = "waiting";
  queue: WorktreeLandingOperation["queue"];
  strategy: WorktreeLandingOperation["strategy"];
  allowDirtyTarget = false;
  resolveAfterLanding: WorktreeLandingOperation["resolveAfterLanding"];
  automatic: WorktreeLandingOperation["automatic"];
  pauseReason: WorktreeLandingOperation["pauseReason"];
  error: string | undefined;
  resolvedSessionIds: WorktreeLandingOperation["resolvedSessionIds"];
  cleanupFailures: (typeof WorktreeLandingOperation.Encoded)["cleanupFailures"];
}
