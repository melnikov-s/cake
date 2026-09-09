import { Model, id } from "r-state-tree";
import type {
  WorktreeLandingPhase,
  WorktreeLandingOperation,
} from "../../domain/worktrees/worktree-landing-data";

/** Passive process-lifetime projection of one main-owned landing operation. */
export class WorktreeOperation extends Model {
  operationId = "";
  @id workspacePath = "";
  sessionId = "";
  kind: WorktreeLandingOperation["kind"] = "landing";
  phase: WorktreeLandingPhase = "waiting";
  strategy: WorktreeLandingOperation["strategy"];
  allowDirtyTarget = false;
  resolveAfterLanding: WorktreeLandingOperation["resolveAfterLanding"];
  pauseReason: WorktreeLandingOperation["pauseReason"];
  error: string | undefined;
}
