import { AutoMergeRequest, ProjectAutoMerge } from "./auto-merge";
import { Schema } from "effect";
import { WorktreeLandingOperation } from "./worktree-landing-data";

/** Current process-lifetime landing and queue operations shared by every renderer. */
export const WorktreeOperationCatalogUpdate = Schema.Struct({
  operations: Schema.Array(WorktreeLandingOperation),
  autoMergeProjects: Schema.optionalKey(Schema.Array(ProjectAutoMerge)),
  autoMergeRequests: Schema.optionalKey(Schema.Array(AutoMergeRequest)),
});
export type WorktreeOperationCatalogUpdate = Schema.Schema.Type<
  typeof WorktreeOperationCatalogUpdate
>;
