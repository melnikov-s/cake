import { Schema } from "effect";
import { WorktreeRecord } from "../domain/managed-worktree-data";

const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const worktreeStatusSchema = Schema.Struct({
  record: WorktreeRecord,
  targetBranch: bounded(1, 512),
  dirtyCount: nonNegativeInt,
  aheadCount: nonNegativeInt,
  behindCount: nonNegativeInt,
  merged: Schema.Boolean,
  targetDirty: Schema.Boolean,
  targetOnBranch: Schema.Boolean,
  merging: Schema.Boolean,
  rebasing: Schema.Boolean,
  squashMessageReady: Schema.Boolean,
  landingState: Schema.optionalKey(Schema.Literals(["running", "queued"])),
  landingOperationId: Schema.optionalKey(bounded(1, 256)),
  landingQueuePosition: Schema.optionalKey(nonNegativeInt),
});
export type WorktreeStatus = typeof worktreeStatusSchema.Type;
export type WorktreeLandRequest =
  | { readonly strategy: "preserve"; readonly allowDirtyTarget?: true }
  | {
      readonly strategy: "squash";
      readonly message?: string;
      readonly allowDirtyTarget?: true;
    };
export type WorktreeRebaseOutcome =
  | { readonly outcome: "rebased" }
  | { readonly outcome: "resolving"; readonly files: ReadonlyArray<string> };
export interface WorktreeLandingCoordinator {
  proposeSquashMessage(input: {
    workspacePath: string;
    subject: string;
    body?: string;
  }): Promise<void>;
}
export type WorktreeLandOutcome =
  | { readonly outcome: "landed"; readonly commit?: string }
  | { readonly outcome: "resolving"; readonly files: ReadonlyArray<string> }
  | { readonly outcome: "proposal" };
