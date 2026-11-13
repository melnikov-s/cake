import { Model, id } from "r-state-tree";
import type { WorktreeRecord } from "../../contracts/worktrees/managed-worktree-data";
import type { ContributionStats } from "../../contracts/worktrees/worktree-changes";

/** Passive renderer projection of one main-owned Managed Worktree record. */
export class ManagedWorktree extends Model {
  projectPath = "";
  @id worktreePath = "";
  checkoutPath: string | undefined;
  branch = "";
  baseBranch = "";
  defaultBranch: string | undefined;
  contributionStats: ContributionStats | undefined;
  baseCommit: string | undefined;
  contributionRef: string | undefined;
  parentWorktreePath: string | undefined;
  state: WorktreeRecord["state"];
  resolvedFrom: WorktreeRecord["resolvedFrom"];
  createdAt = "";
  pendingStrategy: WorktreeRecord["pendingStrategy"];
  pendingAutomaticLanding: WorktreeRecord["pendingAutomaticLanding"];
  pendingLandingOperationId: WorktreeRecord["pendingLandingOperationId"];
  resolveAfterLanding: WorktreeRecord["resolveAfterLanding"];
}
