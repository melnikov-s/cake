import { SessionManager } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { copyFile, stat, utimes } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Effect, Exit, FileSystem, Path, Schema } from "effect";
import type { CakePaths } from "../../config/CakePaths";
import { WorktreeStorage } from "../storage/WorktreeStorage";
import {
  SessionArchiveStorage,
  SessionResolutionIndex,
  ProjectSessionArchiveMetadata,
} from "../storage/SessionArchiveStorage";
import { workingDirectorySessionPath } from "../storage/session-files";
import { atomicWriteFile } from "../storage/internal/atomicFile";

// Read only the stable project-routing fields from supported storage envelopes.
// This maintenance command must not decode/rewrite unrelated, newer Cake settings.
const StoredMigrationProjects = Schema.Struct({
  version: Schema.Literals([5, 6]),
  data: Schema.Struct({
    projects: Schema.Array(Schema.Struct({ path: Schema.String, name: Schema.String })),
  }),
});

const ReceiptEntry = Schema.Struct({
  source: Schema.String,
  destination: Schema.String,
  digest: Schema.String,
});
const Receipts = Schema.Struct({
  version: Schema.Literal(1),
  sessions: Schema.Record(Schema.String, ReceiptEntry),
});
const MigrationItem = Schema.Struct({
  sessionId: Schema.String,
  workingDirectory: Schema.String,
  source: Schema.String,
  destination: Schema.String,
  digest: Schema.String,
  resolved: Schema.Boolean,
  completed: Schema.Boolean,
  metadata: Schema.optionalKey(ProjectSessionArchiveMetadata),
});
export const PiSessionMigrationPlan = Schema.Struct({
  version: Schema.Literal(1),
  sourceRoot: Schema.String,
  destinationRoot: Schema.String,
  items: Schema.Array(MigrationItem),
  conflicts: Schema.Array(Schema.String),
});
export interface PiSessionMigrationPlan extends Schema.Schema.Type<typeof PiSessionMigrationPlan> {}
class PiSessionMigrationError extends Schema.TaggedError<PiSessionMigrationError>()(
  "PiSessionMigrationError",
  { message: Schema.String },
) {}
const migrationError = (cause: unknown) =>
  new PiSessionMigrationError({
    message: cause instanceof Error ? cause.message || String(cause) : String(cause),
  });
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const receiptPath = (paths: CakePaths) =>
  `${paths.resolvedProjectMetadata}/pi-session-migration.json`;

const readDocument = Effect.fn("PiSessionMigration.readDocument")(function* <
  S extends Schema.ConstraintDecoder<unknown>,
>(file: string, schema: S) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(file))) return undefined;
  return yield* fs
    .readFileString(file)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))));
});

/** Read-only. Neither normal startup nor session discovery invokes this migration. */
export const planPiSessionMigration = Effect.fn("PiSessionMigration.plan")(function* (
  paths: CakePaths,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceRoot = path.join(paths.home, "pi", "sessions");
  const archivedRoot = path.join(paths.home, "pi", "resolved-sessions");
  const receipts = (yield* readDocument(receiptPath(paths), Receipts)) ?? {
    version: 1 as const,
    sessions: {},
  };
  const resolution = (yield* readDocument(
    path.join(paths.resolvedProjectMetadata, "resolution.json"),
    SessionResolutionIndex,
  )) ?? { version: 1 as const, directories: {} };
  const projects =
    (yield* readDocument(path.join(paths.state, "application.json"), StoredMigrationProjects))?.data
      .projects ?? [];
  const worktrees = yield* (yield* WorktreeStorage).load();
  const items: Schema.Schema.Type<typeof MigrationItem>[] = [];
  const conflicts: string[] = [];
  const seen = new Set<string>();
  // Pi interprets history and identities. Cake only carries the original bytes.
  for (const root of [sourceRoot, archivedRoot]) {
    const directories = [root];
    if (yield* fs.exists(root)) {
      for (const name of yield* fs.readDirectory(root)) {
        const directory = path.join(root, name);
        if ((yield* fs.stat(directory)).type === "Directory") directories.push(directory);
      }
    }
    // Pi listAll(customDir) is flat; old Cake roots contain encoded-cwd folders.
    const sessions = (yield* Effect.forEach(directories, (directory) =>
      Effect.tryPromise({
        try: (signal) => SessionManager.listAll(directory, undefined, signal),
        catch: migrationError,
      }),
    )).flat();
    for (const session of sessions) {
      if (seen.has(session.id)) {
        conflicts.push(`Duplicate source session ID: ${session.id}`);
        continue;
      }
      seen.add(session.id);
      const destination = path.join(
        workingDirectorySessionPath(session.cwd, paths.piSessions),
        path.basename(session.path),
      );
      const checksum = digest(yield* fs.readFile(session.path));
      const receipt = receipts.sessions[session.id];
      const inPlace = path.resolve(session.path) === path.resolve(destination);
      const completed =
        inPlace ||
        Boolean(
          receipt &&
          receipt.source === session.path &&
          receipt.destination === destination &&
          receipt.digest === checksum,
        );
      if (completed && !(yield* fs.exists(destination)))
        conflicts.push(`Previously migrated destination is missing: ${destination}`);
      if (!completed && (yield* fs.exists(destination)))
        conflicts.push(`Destination already exists: ${destination}`);
      // Catch same-ID files with different timestamps, not just filename collisions.
      const existing = SessionManager.findById(session.cwd, session.id, path.dirname(destination));
      if (existing && !completed)
        conflicts.push(`Pi already has session ID ${session.id}: ${existing}`);
      const resolved =
        root === archivedRoot ||
        (resolution.directories[path.dirname(session.path)] ?? []).includes(session.id);
      const worktree = worktrees.find((record) => record.worktreePath === session.cwd);
      const project = projects.find(
        (record) => record.path === (worktree?.projectPath ?? session.cwd),
      );
      let item: Schema.Schema.Type<typeof MigrationItem> = {
        sessionId: session.id,
        workingDirectory: session.cwd,
        source: session.path,
        destination,
        digest: checksum,
        resolved,
        completed,
      };
      if (resolved && project) {
        const metadata: ProjectSessionArchiveMetadata = {
          version: 2,
          sessionId: session.id,
          projectPath: project.path,
          projectName: project.name,
          workingDirectory: session.cwd,
          activeRoot: sourceRoot,
          resolvedRoot: archivedRoot,
          createdAt: session.created.toISOString(),
          modifiedAt: session.modified.toISOString(),
        };
        item = {
          ...item,
          metadata: worktree
            ? { ...metadata, worktreeName: worktree.branch.replace(/^agent\//, "") }
            : metadata,
        };
      }
      items.push(item);
    }
  }
  items.sort((left, right) => left.source.localeCompare(right.source));
  return {
    version: 1 as const,
    sourceRoot,
    destinationRoot: paths.piSessions,
    items,
    conflicts,
  } satisfies PiSessionMigrationPlan;
}, Effect.mapError(migrationError));

/** Explicit opt-in only. Close Cake and terminal Pi before applying a reviewed plan.
 * Originals are retained as backups, also preserving old Pi parentSession references.
 * Credentials, settings, extensions and sidecar sessions are never copied or overwritten.
 */
export const applyPiSessionMigration = Effect.fn("PiSessionMigration.apply")(function* (
  paths: CakePaths,
  input: PiSessionMigrationPlan,
) {
  const plan = yield* Schema.decodeUnknownEffect(PiSessionMigrationPlan)(input);
  if (plan.conflicts.length) return yield* migrationError(plan.conflicts.join("\n"));
  const current = yield* planPiSessionMigration(paths);
  if (JSON.stringify(current) !== JSON.stringify(plan))
    return yield* migrationError("Migration plan changed. Review a fresh plan before applying it.");
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const archive = yield* SessionArchiveStorage;
  let receipts = (yield* readDocument(receiptPath(paths), Receipts)) ?? {
    version: 1 as const,
    sessions: {},
  };
  let copied = 0;
  for (const item of plan.items) {
    if (item.completed) continue;
    const from = {
      cwd: item.workingDirectory,
      activeRoot: plan.sourceRoot,
      resolvedRoot: path.join(paths.home, "pi", "resolved-sessions"),
    };
    const to = {
      cwd: item.workingDirectory,
      activeRoot: paths.piSessions,
      resolvedRoot: paths.piResolvedSessions,
    };
    // Per-file commit is bounded and interruption-safe; cancellation between files is
    // recoverable through receipts. Exclusive copy never overwrites a concurrent file.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        if (digest(yield* fs.readFile(item.source)) !== item.digest)
          return yield* migrationError(`Source changed: ${item.source}`);
        yield* fs.makeDirectory(path.dirname(item.destination), { recursive: true, mode: 0o700 });
        yield* Effect.tryPromise({
          try: () => copyFile(item.source, item.destination, constants.COPYFILE_EXCL),
          catch: migrationError,
        });
        yield* Effect.gen(function* () {
          if (
            digest(yield* fs.readFile(item.destination)) !== item.digest ||
            digest(yield* fs.readFile(item.source)) !== item.digest
          )
            return yield* migrationError(`Source changed while copying: ${item.source}`);
          const sourceStat = yield* Effect.tryPromise({
            try: () => stat(item.source),
            catch: migrationError,
          });
          yield* Effect.tryPromise({
            try: () =>
              utimes(item.destination, sourceStat.atimeMs / 1000, sourceStat.mtimeMs / 1000),
            catch: migrationError,
          });
          yield* archive.relocate(item.sessionId, from, to, item.resolved, item.metadata);
          const next = {
            version: 1 as const,
            sessions: {
              ...receipts.sessions,
              [item.sessionId]: {
                source: item.source,
                destination: item.destination,
                digest: item.digest,
              },
            },
          };
          yield* atomicWriteFile(
            fs,
            path,
            receiptPath(paths),
            `${JSON.stringify(next, null, 2)}\n`,
            (_stage, cause) => migrationError(cause),
          );
          receipts = next;
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.gen(function* () {
                  yield* archive.relocate(item.sessionId, to, from, item.resolved, item.metadata);
                  yield* fs.remove(item.destination);
                }),
          ),
        );
      }),
    );
    copied += 1;
  }
  return { copied, alreadyCopied: plan.items.length - copied, originalsRetained: true as const };
}, Effect.mapError(migrationError));
