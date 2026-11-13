import { Schema } from "effect";

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Committed net contribution; null counts mean attribution is unavailable, never zero. */
export const ContributionStats = Schema.Struct({
  additions: Schema.NullOr(count),
  deletions: Schema.NullOr(count),
  unavailableReason: Schema.NullOr(Schema.String),
});
export interface ContributionStats extends Schema.Schema.Type<typeof ContributionStats> {}

/** Git numstat uses null counts for binary files. */
export const ChangedFile = Schema.Struct({
  path: Schema.NonEmptyString,
  deleted: Schema.Boolean,
  workingTreeExists: Schema.Boolean,
  additions: Schema.NullOr(count),
  deletions: Schema.NullOr(count),
});
export interface ChangedFile extends Schema.Schema.Type<typeof ChangedFile> {}

export const BranchCommit = Schema.Struct({
  hash: Schema.NonEmptyString,
  subject: Schema.String,
  files: Schema.Array(ChangedFile),
});
export interface BranchCommit extends Schema.Schema.Type<typeof BranchCommit> {}

/** A local or remote-tracking branch HEAD could have forked from, with its fork point's distance from HEAD. */
const BaseAlternative = Schema.Struct({
  branch: Schema.NonEmptyString,
  distance: count,
});

/** Maximum commits listed; `totalCommits` reports the full range. */
export const commitListLimit = 200;

export const WorktreeChanges = Schema.Struct({
  branch: Schema.String,
  /** Configured landing target for managed worktrees; inferred parent otherwise. */
  base: Schema.NullOr(Schema.String),
  baseAlternatives: Schema.Array(BaseAlternative),
  /** Immutable counterfactual baseline -> actual HEAD, shared by files and aggregate counts. */
  baseRevision: Schema.NullOr(Schema.String),
  headRevision: Schema.String,
  contributionUnavailableReason: Schema.NullOr(Schema.String),
  files: Schema.Array(ChangedFile),
  /** Unlanded per-commit historical edits, not the net contribution totals. */
  commits: Schema.Array(BranchCommit),
  totalCommits: count,
  staged: Schema.Array(ChangedFile),
  unstaged: Schema.Array(ChangedFile),
});
export interface WorktreeChanges extends Schema.Schema.Type<typeof WorktreeChanges> {}

export function changeTotals(files: readonly Pick<ChangedFile, "additions" | "deletions">[]) {
  return files.reduce<{ additions: number; deletions: number; binary: number }>(
    (total, file) => ({
      additions: total.additions + (file.additions ?? 0),
      deletions: total.deletions + (file.deletions ?? 0),
      binary: total.binary + (file.additions === null ? 1 : 0),
    }),
    { additions: 0, deletions: 0, binary: 0 },
  );
}
