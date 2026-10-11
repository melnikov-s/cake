import { Schema } from "effect";

const sessionId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const workingDirectory = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768));
const sessionIds = Schema.Array(sessionId).check(Schema.isMaxLength(10_000));

/** A known policy refusal before the resolution authority commits. */
export class ResolutionRejected extends Schema.TaggedError<ResolutionRejected>()(
  "ResolutionRejected",
  {
    operation: Schema.String,
    sessionIds,
    message: Schema.String,
  },
) {}

export const ResolutionCleanupFailure = Schema.Struct({
  workingDirectory,
  message: Schema.String,
});
export interface ResolutionCleanupFailure extends Schema.Schema.Type<
  typeof ResolutionCleanupFailure
> {}

/** Confirms resolution committed; only follow-up checkout cleanup failed. Never means rollback. */
export class ResolutionCleanupFailed extends Schema.TaggedError<ResolutionCleanupFailed>()(
  "ResolutionCleanupFailed",
  {
    operation: Schema.String,
    resolvedSessionIds: sessionIds.check(Schema.isMinLength(1)),
    cleanupFailures: Schema.Array(ResolutionCleanupFailure).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(10_000),
    ),
    message: Schema.String,
  },
) {}

export const ProjectSessionResolutionDomainFailure = Schema.Union([
  ResolutionRejected,
  ResolutionCleanupFailed,
]);
export type ProjectSessionResolutionDomainFailure =
  typeof ProjectSessionResolutionDomainFailure.Type;

/**
 * Per-target batch failures that do not confirm committed resolution.
 * General operational failures remain summaries, not claims that nothing changed.
 */
export const WorkingDirectoryResolutionFailure = Schema.Struct({
  sessionIds,
  message: Schema.String,
});
export interface WorkingDirectoryResolutionFailure extends Schema.Schema.Type<
  typeof WorkingDirectoryResolutionFailure
> {}

export const WorkingDirectoryResolutionResult = Schema.Struct({
  projectPath: workingDirectory,
  workingDirectory,
  resolvedSessionIds: sessionIds,
  failures: Schema.Array(WorkingDirectoryResolutionFailure).check(Schema.isMaxLength(10_000)),
  cleanupFailures: Schema.Array(ResolutionCleanupFailed).check(Schema.isMaxLength(10_000)),
});
export interface WorkingDirectoryResolutionResult extends Schema.Schema.Type<
  typeof WorkingDirectoryResolutionResult
> {}
