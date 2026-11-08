import { Effect, Stream } from "effect";
import type {
  WorktreeRecord,
  WorktreeCatalogEntry,
  ManagedWorktreeCatalogUpdate,
} from "../../contracts/worktrees/managed-worktree-data";
import type { ManagedWorktreeError } from "../../contracts/worktrees/managed-worktrees-errors";
import type { Git } from "../../services/git/Git";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import { makeCommitStatsReader } from "./worktreeCommitStats";
import { localDefaultBranch } from "../../services/git/default-branch";
import { ManagedWorktrees } from "../../services/worktrees/ManagedWorktrees";

const entry = (record: WorktreeRecord, defaultBranch: string | undefined): WorktreeCatalogEntry =>
  defaultBranch ? { ...record, defaultBranch } : record;

/** Enrich at the backend observation boundary, once per Project in each update, not per row. */
const projectUpdate = Effect.fn("WorktreeCatalog.projectUpdate")(function* (
  update: ManagedWorktreeCatalogUpdate,
  readStats: Effect.Success<ReturnType<typeof makeCommitStatsReader>>,
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
      worktrees: yield* Effect.forEach(
        update.worktrees,
        (record) =>
          readStats(record).pipe(
            Effect.map((commitStats) => ({
              ...entry(record, defaults.get(record.projectPath)),
              commitStats,
            })),
          ),
        { concurrency: 4 },
      ),
    };
  }
  const worktree = update.event.worktree;
  const defaultBranch = yield* localDefaultBranch(worktree.projectPath);
  return {
    _tag: "Event" as const,
    event: {
      _tag: "Upserted" as const,
      worktree: {
        ...entry(worktree, defaultBranch),
        commitStats: yield* readStats(worktree),
      },
    },
  };
});

/** Display metadata is ephemeral and never written into Managed Worktree lifecycle storage. */
export const observe = (): Stream.Stream<
  ManagedWorktreeCatalogUpdate,
  ManagedWorktreeError,
  ManagedWorktrees | Git | SessionCatalogChanges
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const worktrees = yield* ManagedWorktrees;
      const changes = yield* SessionCatalogChanges;
      const readStats = yield* makeCommitStatsReader();
      // Existing activity notifications cover turn start/settlement (including abort).
      // Refresh the source and worktrees landing there: target advancement changes outstanding
      // stats even when a child's HEAD is unchanged. Title/read changes do no Git work.
      const refreshes = changes.initialThenChanges(Stream.empty).pipe(
        Stream.filter(
          (change) =>
            change._tag === "ProjectSessionActivityChanged" ||
            change._tag === "ProjectSessionChanged",
        ),
        Stream.mapEffect((change) =>
          worktrees.records().pipe(
            Effect.map((records) =>
              records
                .filter(
                  (record) =>
                    record.projectPath === change.projectPath &&
                    (record.worktreePath === change.workingDirectory ||
                      (record.parentWorktreePath ?? record.projectPath) ===
                        change.workingDirectory),
                )
                .map((worktree): ManagedWorktreeCatalogUpdate => ({
                  _tag: "Event",
                  event: { _tag: "Upserted", worktree },
                })),
            ),
          ),
        ),
        Stream.flatMap(Stream.fromIterable),
      );
      return Stream.merge(worktrees.observe(), refreshes, { haltStrategy: "left" }).pipe(
        Stream.mapEffect((update) => projectUpdate(update, readStats)),
      );
    }),
  );
