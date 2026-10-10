import { Schema } from "effect";

const boundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));

export const ResolvedManagedWorktreeCleanupPlan = Schema.Struct({
  projectPath: boundedPath,
  workingDirectories: Schema.Array(boundedPath).check(Schema.isMaxLength(500)),
});
export interface ResolvedManagedWorktreeCleanupPlan extends Schema.Schema.Type<
  typeof ResolvedManagedWorktreeCleanupPlan
> {}

export const ResolvedManagedWorktreeCleanupFailure = Schema.Struct({
  workingDirectory: boundedPath,
  message: Schema.String,
});
export interface ResolvedManagedWorktreeCleanupFailure extends Schema.Schema.Type<
  typeof ResolvedManagedWorktreeCleanupFailure
> {}

export const ResolvedManagedWorktreeCleanupResult = Schema.Struct({
  projectPath: boundedPath,
  discardedWorkingDirectories: Schema.Array(boundedPath).check(Schema.isMaxLength(500)),
  failures: Schema.Array(ResolvedManagedWorktreeCleanupFailure).check(Schema.isMaxLength(500)),
});
export interface ResolvedManagedWorktreeCleanupResult extends Schema.Schema.Type<
  typeof ResolvedManagedWorktreeCleanupResult
> {}
