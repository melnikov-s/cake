import { Effect, Schema } from "effect";
import type { WorktreeRecord } from "../../contracts/worktrees/managed-worktree-data";
import type { GitService } from "../git/Git";

const revision = Schema.NonEmptyString;
const PendingImport = Schema.Struct({
  target: revision,
  baseline: Schema.optionalKey(revision),
  tree: Schema.optionalKey(revision),
  reason: Schema.optionalKey(Schema.String),
});
/** One atomic Git-ref checkpoint. Parents retain every referenced object through Git GC. */
const Checkpoint = Schema.Struct({
  version: Schema.Literal(1),
  origin: revision,
  source: revision,
  baseline: revision,
  retiredSource: Schema.optionalKey(revision),
  reason: Schema.optionalKey(Schema.String),
  pending: Schema.optionalKey(PendingImport),
});
interface Checkpoint extends Schema.Schema.Type<typeof Checkpoint> {}

export interface ContributionEvidence {
  readonly baseline: string | null;
  readonly tip: string;
  readonly unavailableReason: string | null;
}
const unavailable = (tip: string, unavailableReason: string): ContributionEvidence => ({
  baseline: null,
  tip,
  unavailableReason,
});
class ContributionUnavailable extends Schema.TaggedError<ContributionUnavailable>()(
  "ContributionUnavailable",
  { message: Schema.String },
) {}
const failure = (message: string) => Effect.fail(new ContributionUnavailable({ message }));

/**
 * Git-native attribution, independent of the mutable landing range. Local commits change only
 * the source; a clean upstream import transforms the counterfactual (no-local-edits) baseline
 * by the SAME import delta. Thus baseline -> source is the worktree's net contribution.
 */
export const makeContributionRepository = (projectPath: string, git: GitService) => {
  const run = (args: readonly string[]) => git.run(projectPath, args);
  const resolve = (ref: string) =>
    run(["rev-parse", "--verify", `${ref}^{commit}`]).pipe(Effect.map((value) => value.trim()));
  const treeOf = (ref: string) =>
    run(["rev-parse", `${ref}^{tree}`]).pipe(Effect.map((value) => value.trim()));
  const ancestor = (left: string, right: string) =>
    run(["merge-base", "--is-ancestor", left, right]).pipe(
      Effect.map(() => true),
      Effect.catch(() => Effect.succeed(false)),
    );
  const commitTree = (tree: string, parents: readonly string[], message: string) =>
    run([
      "-c",
      "user.name=Cake",
      "-c",
      "user.email=contribution@cake.local",
      "commit-tree",
      tree,
      ...[...new Set(parents)].flatMap((parent) => ["-p", parent]),
      "-m",
      message,
    ]).pipe(Effect.map((value) => value.trim()));
  const mergeTree = (left: string, right: string, base?: string) =>
    run([
      "merge-tree",
      "--write-tree",
      ...(base ? [`--merge-base=${base}`] : []),
      left,
      right,
    ]).pipe(Effect.map((value) => value.split("\n")[0]?.trim() ?? ""));
  const importBaseline = Effect.fn("WorktreeContribution.importBaseline")(function* (
    baseline: string,
    source: string,
    imported: string,
  ) {
    const tree = yield* mergeTree(baseline, imported, source);
    return yield* commitTree(tree, [baseline, imported], "Cake contribution baseline");
  });
  const load = Effect.fn("WorktreeContribution.load")(function* (ref: string) {
    const revision = yield* resolve(ref);
    const text = yield* run(["show", "--no-patch", "--format=%B", revision]);
    const checkpoint = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Checkpoint))(
      text.trim(),
    );
    return { revision, checkpoint };
  });
  const save = Effect.fn("WorktreeContribution.save")(function* (
    ref: string,
    checkpoint: Checkpoint,
    previous?: string,
  ) {
    if (previous) {
      const current = yield* run(["show", "--no-patch", "--format=%B", previous]);
      if (current.trim() === JSON.stringify(checkpoint)) return checkpoint;
    }
    const parents = [
      checkpoint.origin,
      checkpoint.source,
      checkpoint.baseline,
      ...(previous ? [previous] : []),
      ...(checkpoint.pending?.baseline ? [checkpoint.pending.baseline] : []),
      ...(checkpoint.pending ? [checkpoint.pending.target] : []),
    ];
    const revision = yield* commitTree(
      yield* treeOf(checkpoint.source),
      parents,
      JSON.stringify(checkpoint),
    );
    // Compare-and-swap makes checkpoints atomic. Retrying cannot overwrite newer evidence.
    yield* run(["update-ref", ref, revision, previous ?? ""]).pipe(Effect.uninterruptible);
    return checkpoint;
  });
  const walk = (tip: string, source: string) =>
    run(["rev-list", "--first-parent", "--parents", tip, `^${source}`, "--"]).pipe(
      Effect.map((text) =>
        text
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => line.split(" ")),
      ),
    );
  const onFirstParent = Effect.fn("WorktreeContribution.onFirstParent")(function* (
    source: string,
    tip: string,
  ) {
    if (source === tip) return true;
    const rows = yield* walk(tip, source);
    return rows.at(-1)?.[1] === source;
  });
  const settle = Effect.fn("WorktreeContribution.settle")(function* (
    checkpoint: Checkpoint,
    tip: string,
  ): Effect.fn.Return<Checkpoint, unknown> {
    const pending = checkpoint.pending;
    if (!pending) return checkpoint;
    const { pending: _pending, ...original } = checkpoint;
    if (!pending.baseline || !pending.tree) {
      if (yield* onFirstParent(checkpoint.source, tip)) return original;
      return { ...original, reason: pending.reason ?? "The rebase required conflict resolution" };
    }
    // Recover a successful replay even after a crash and subsequent local commits. A matching
    // tree on the target's first-parent lineage is the exact precomputed import checkpoint.
    const rows = yield* run(["log", "--first-parent", "--format=%H %T", tip, "--"]);
    for (const row of rows.trim().split("\n")) {
      const [commit, tree] = row.split(" ");
      if (!commit) continue;
      if (tree === pending.tree && (yield* onFirstParent(pending.target, commit)))
        return { ...original, source: commit, baseline: pending.baseline };
      if (commit === pending.target) break;
    }
    // No matching rewritten checkpoint: unchanged old ancestry proves an abort/no-op.
    if (yield* onFirstParent(checkpoint.source, tip)) return original;
    return {
      ...original,
      reason: "The rewritten history does not match the recorded clean rebase",
    };
  });
  const extend = Effect.fn("WorktreeContribution.extend")(function* (
    checkpoint: Checkpoint,
    tip: string,
    target: string,
  ): Effect.fn.Return<Checkpoint, unknown> {
    checkpoint = yield* settle(checkpoint, tip);
    if (checkpoint.reason) return checkpoint;
    if (!(yield* onFirstParent(checkpoint.source, tip)))
      return { ...checkpoint, reason: "History was rewritten without a contribution checkpoint" };
    let baseline = checkpoint.baseline;
    const rows = yield* walk(tip, checkpoint.source);
    for (const row of rows.toReversed()) {
      const [commit, parent, ...imports] = row;
      if (!commit || !parent)
        return { ...checkpoint, reason: "The contribution history is incomplete" };
      if (imports.length === 0) {
        if ((yield* ancestor(commit, target)) && (yield* onFirstParent(commit, target)))
          return {
            ...checkpoint,
            reason:
              "History contains upstream or landed commits without a recorded import boundary",
          };
        continue;
      }
      const imported = imports[0];
      if (imports.length !== 1 || !imported || !(yield* ancestor(imported, target)))
        return {
          ...checkpoint,
          reason: "A merge imports history outside the recorded landing target",
        };
      const clean = yield* Effect.result(mergeTree(parent, imported));
      if (clean._tag === "Failure" || clean.success !== (yield* treeOf(commit)))
        return {
          ...checkpoint,
          reason: "A merge contains conflict-resolution or additional edits",
        };
      const transformed = yield* Effect.result(importBaseline(baseline, parent, commit));
      if (transformed._tag === "Failure")
        return { ...checkpoint, reason: "Upstream edits overlap this worktree's contribution" };
      baseline = transformed.success;
    }
    return { ...checkpoint, baseline, source: tip };
  });
  const readCheckpoint = Effect.fn("WorktreeContribution.readCheckpoint")(function* (
    record: WorktreeRecord,
    checkpointRevision = record.contributionRef,
  ): Effect.fn.Return<Checkpoint, unknown> {
    if (checkpointRevision)
      return (yield* load(checkpointRevision).pipe(
        Effect.catch(() =>
          failure("The recorded contribution checkpoint is missing or unreadable"),
        ),
      )).checkpoint;
    // Recover legacy evidence only when the frozen start and graph still prove a local fork.
    // In particular, never reinterpret a rebased/landed current merge-base as the creation base.
    if (!record.baseCommit) return yield* failure("The worktree has no recorded creation baseline");
    const origin = yield* resolve(record.baseCommit);
    return { version: 1, origin, source: origin, baseline: origin };
  });
  const sourceTip = Effect.fn("WorktreeContribution.sourceTip")(function* (
    record: WorktreeRecord,
    source = `refs/heads/${record.branch}`,
  ) {
    const current = yield* Effect.result(resolve(source));
    if (current._tag === "Success") return current.success;
    if (record.contributionRef && ["resolved", "discarded"].includes(record.state ?? "active")) {
      const { checkpoint } = yield* load(record.contributionRef);
      if (checkpoint.retiredSource !== checkpoint.source)
        return yield* failure(
          "The branch disappeared without a contribution retirement checkpoint",
        );
      return yield* resolve(checkpoint.source);
    }
    return yield* Effect.fail(current.failure);
  });
  // Exposed diff revisions need their own GC root; observations must not clear pending replay.
  const retainView = Effect.fn("WorktreeContribution.retainView")(function* (
    record: WorktreeRecord,
    checkpoint: Checkpoint,
  ) {
    const ref = record.contributionRef
      ? record.contributionRef.replace("refs/cake/contributions/", "refs/cake/contribution-views/")
      : `refs/cake/contribution-views/legacy/${checkpoint.origin}/${record.branch}`;
    const previous = yield* resolve(ref).pipe(Effect.catch(() => Effect.succeed(undefined)));
    const tree = yield* treeOf(checkpoint.baseline);
    if (previous && (yield* treeOf(previous)) === tree) return previous;
    const retained = yield* commitTree(
      tree,
      [checkpoint.baseline, ...(previous ? [previous] : [])],
      "Cake contribution diff",
    );
    const saved = yield* Effect.result(
      run(["update-ref", ref, retained, previous ?? ""]).pipe(Effect.uninterruptible),
    );
    if (saved._tag === "Success") return retained;
    // Concurrent observers retaining the same tree share the winning root, never overwrite it.
    const winner = yield* resolve(ref);
    if ((yield* treeOf(winner)) === tree) return winner;
    return yield* failure("The contribution view changed while being retained; refresh changes");
  });
  const inspect = Effect.fn("WorktreeContribution.inspect")(function* (
    record: WorktreeRecord,
    source = `refs/heads/${record.branch}`,
    target = `refs/heads/${record.baseBranch}`,
    checkpointRevision?: string,
  ) {
    const tip = yield* sourceTip(record, source);
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const checkpoint = yield* readCheckpoint(record, checkpointRevision);
        if (checkpoint.pending && ["active", "landed"].includes(record.state ?? "active")) {
          const attached = yield* Effect.result(
            git.run(record.worktreePath, ["symbolic-ref", "--quiet", "HEAD"]),
          );
          if (attached._tag === "Failure")
            return yield* failure("A recorded rebase is in progress or the checkout is detached");
        }
        const extended = yield* extend(checkpoint, tip, yield* resolve(target));
        if (
          extended.reason ||
          extended.baseline === checkpoint.baseline ||
          extended.baseline === checkpoint.pending?.baseline
        )
          return extended;
        return { ...extended, baseline: yield* retainView(record, extended) };
      }),
    );
    if (result._tag === "Failure")
      return unavailable(
        tip,
        result.failure instanceof Error ? result.failure.message : String(result.failure),
      );
    const checkpoint = result.success;
    return checkpoint.reason
      ? unavailable(tip, checkpoint.reason)
      : { baseline: checkpoint.baseline, tip, unavailableReason: null };
  });
  const initialize = Effect.fn("WorktreeContribution.initialize")(function* (
    ref: string,
    origin: string,
  ) {
    const existing = yield* Effect.result(load(ref));
    if (existing._tag === "Success") {
      if (existing.success.checkpoint.origin !== origin)
        return yield* failure("Contribution origin changed");
      return existing.success.checkpoint;
    }
    return yield* save(ref, { version: 1, origin, source: origin, baseline: origin });
  });
  const checkpoint = Effect.fn("WorktreeContribution.checkpoint")(function* (
    record: WorktreeRecord,
    ref: string,
    retirement = false,
  ) {
    const tip = yield* resolve(`refs/heads/${record.branch}`);
    const existing = yield* Effect.result(load(ref));
    const recovered =
      existing._tag === "Success"
        ? Effect.succeed(existing.success.checkpoint)
        : readCheckpoint(record);
    const initial = yield* recovered.pipe(
      Effect.catch((error) =>
        Effect.succeed({
          version: 1 as const,
          origin: tip,
          source: tip,
          baseline: tip,
          reason: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
    const extended = yield* extend(initial, tip, yield* resolve(`refs/heads/${record.baseBranch}`));
    const { retiredSource: _retiredSource, ...active } = extended;
    const next = retirement ? { ...active, retiredSource: active.source } : active;
    const previous =
      existing._tag === "Success"
        ? existing.success.revision
        : yield* resolve(ref).pipe(Effect.catch(() => Effect.succeed(undefined)));
    yield* save(ref, next, previous);
    return next;
  });
  const prepareImport = Effect.fn("WorktreeContribution.prepareImport")(function* (
    ref: string,
    target: string,
    acknowledgedSource?: string,
  ) {
    const loaded = yield* load(ref);
    const checkpoint = loaded.checkpoint;
    const targetTip = yield* resolve(target);
    if (checkpoint.pending?.target === targetTip) return;
    const planned = yield* Effect.result(
      Effect.gen(function* () {
        const tree = yield* mergeTree(checkpoint.source, targetTip, acknowledgedSource);
        const imported = yield* commitTree(
          tree,
          [checkpoint.source, targetTip],
          "Cake upstream synchronization",
        );
        const baseline = yield* importBaseline(checkpoint.baseline, checkpoint.source, imported);
        return { tree, baseline };
      }),
    );
    yield* save(
      ref,
      {
        ...checkpoint,
        pending:
          planned._tag === "Success"
            ? { target: targetTip, ...planned.success }
            : {
                target: targetTip,
                reason: "The rebase or its counterfactual requires conflict resolution",
              },
      },
      loaded.revision,
    );
  });
  const finishImport = Effect.fn("WorktreeContribution.finishImport")(function* (
    ref: string,
    source: string,
  ) {
    const loaded = yield* load(ref);
    const tip = yield* resolve(source);
    const { retiredSource: _retiredSource, ...settled } = yield* settle(loaded.checkpoint, tip);
    yield* save(ref, settled, loaded.revision);
  });
  const clearRetirement = Effect.fn("WorktreeContribution.clearRetirement")(function* (
    ref: string,
  ) {
    const loaded = yield* load(ref);
    const { retiredSource: _retiredSource, ...active } = loaded.checkpoint;
    yield* save(ref, active, loaded.revision);
  });
  const hasPending = (ref: string) =>
    load(ref).pipe(Effect.map(({ checkpoint }) => checkpoint.pending !== undefined));
  return {
    inspect,
    sourceTip,
    hasPending,
    initialize,
    checkpoint,
    prepareImport,
    finishImport,
    clearRetirement,
  };
};

/** Called under the lifecycle's repository lock BEFORE rewriting or removing source history. */
export const retainContribution = Effect.fn("WorktreeContribution.retain")(function* (
  record: WorktreeRecord,
  persist: (record: WorktreeRecord) => Effect.Effect<void, unknown>,
  git: GitService,
  retirement = false,
) {
  const repository = makeContributionRepository(record.projectPath, git);
  const contributionRef =
    record.contributionRef ?? `refs/cake/contributions/${crypto.randomUUID()}`;
  yield* repository.checkpoint(record, contributionRef, retirement);
  if (record.contributionRef) return record;
  const next = { ...record, contributionRef };
  // The Git root exists before metadata can refer to it. Failure leaves only an inert orphan,
  // never permission to rewrite history without first persisting the provenance reference.
  yield* persist(next);
  return next;
});
