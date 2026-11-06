import { Effect, Stream } from "effect";
import type {
  WorktreeRecord,
  WorktreeCatalogEntry,
  ManagedWorktreeCatalogUpdate,
} from "../../contracts/worktrees/managed-worktree-data";
import type { ManagedWorktreeError } from "../../contracts/worktrees/managed-worktrees-errors";
import type { Git } from "../../services/git/Git";
import { localDefaultBranch } from "../../services/git/default-branch";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";

const entry = (record: WorktreeRecord, defaultBranch: string | undefined): WorktreeCatalogEntry =>
  defaultBranch ? { ...record, defaultBranch } : record;

/** Enrich at the backend observation boundary, once per Project in each update, not per row. */
const projectUpdate = Effect.fn("WorktreeCatalog.projectUpdate")(function* (
  update: ManagedWorktreeCatalogUpdate,
): Effect.fn.Return<ManagedWorktreeCatalogUpdate, never, Git> {
  if (update._tag === "Snapshot") {
    const defaults = new Map(
      yield* Effect.forEach(
        [...new Set(update.worktrees.map((record) => record.projectPath))],
        (root) => localDefaultBranch(root).pipe(Effect.map((branch) => [root, branch] as const)),
      ),
    );
    return {
      _tag: "Snapshot" as const,
      worktrees: update.worktrees.map((record) => entry(record, defaults.get(record.projectPath))),
    };
  }
  const worktree = update.event.worktree;
  const defaultBranch = yield* localDefaultBranch(worktree.projectPath);
  return {
    _tag: "Event" as const,
    event: { _tag: "Upserted" as const, worktree: entry(worktree, defaultBranch) },
  };
});

/** Display metadata is ephemeral and never written into Managed Worktree lifecycle storage. */
export const observe = (): Stream.Stream<
  ManagedWorktreeCatalogUpdate,
  ManagedWorktreeError,
  ManagedWorktrees | Git
> =>
  Stream.unwrap(Effect.map(ManagedWorktrees, (worktrees) => worktrees.observe())).pipe(
    Stream.mapEffect(projectUpdate),
  );
