import { Effect, Stream } from "effect";
import { SavedDraftStorage, SavedDraftError } from "../../services/storage/SavedDraftStorage";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import * as projectSessionLocations from "./projectSessionLocations";
import * as projectSessionOperations from "./projectSessionOperations";
import * as managedWorktrees from "../worktrees/managedWorktrees";
import type { SavedDraft } from "./saved-draft-data";

const requireProject = Effect.fn("SavedDrafts.requireProject")(function* (projectPath: string) {
  const locations = yield* projectSessionLocations.locations();
  if (
    !locations.some(
      (item) => item.projectPath === projectPath && item.workingDirectory === projectPath,
    )
  )
    return yield* new SavedDraftError({
      operation: "project",
      message: "Project is not registered",
    });
});

export const reconcileInterrupted = Effect.fn("SavedDrafts.reconcileInterrupted")(function* () {
  const storage = yield* SavedDraftStorage;
  const sessions = yield* CakeSessionRuntimes;
  const configuration = yield* ProjectSessionConfiguration;
  for (const record of yield* storage.list()) {
    if (record.status !== "activating") continue;
    const target = {
      workingDirectory: record.workingDirectory,
      sessionDirectory: configuration.sessionDirectory,
      sessionId: record.sessionId,
    };
    const active = yield* sessions.currentStatus(target);
    const persisted = yield* sessions
      .catalogEntry(target, record.sessionId)
      .pipe(
        Effect.mapError(
          (cause) => new SavedDraftError({ operation: "reconcile", message: cause.message }),
        ),
      );
    if (active?.pending || active?.streaming || (persisted?.messageCount ?? 0) > 0)
      yield* storage.complete(record.sessionId, record.revision);
    // No catalog entry is not proof of rejection: Pi may accept the first turn
    // before a JSONL file exists. Preserve the claim until explicitly resolved.
  }
});

export const list = Effect.fn("SavedDrafts.list")(function* () {
  // A lost completion receipt can settle after startup. Recheck authoritative
  // Pi evidence whenever clients refresh; uncertain absences remain claimed.
  yield* reconcileInterrupted();
  return yield* (yield* SavedDraftStorage).list();
});

export const observe = Stream.unwrap(
  Effect.gen(function* () {
    yield* reconcileInterrupted();
    return (yield* SavedDraftStorage).observe();
  }),
);

/** An uncertain claim requires a deliberate user decision after checking the transcript.
 * Absence from Pi's catalog alone can never authorize automatic replay. */
export const recoverUncertain = Effect.fn("SavedDrafts.recoverUncertain")(function* (
  sessionId: string,
  expectedRevision: number,
) {
  const storage = yield* SavedDraftStorage;
  const record = (yield* storage.list()).find((item) => item.sessionId === sessionId);
  if (!record || record.status !== "activating")
    return yield* new SavedDraftError({ operation: "recover", message: "No uncertain activation" });
  const sessions = yield* CakeSessionRuntimes;
  const configuration = yield* ProjectSessionConfiguration;
  const target = {
    workingDirectory: record.workingDirectory,
    sessionDirectory: configuration.sessionDirectory,
    sessionId,
  };
  const active = yield* sessions.currentStatus(target);
  const persisted = yield* sessions
    .catalogEntry(target, sessionId)
    .pipe(
      Effect.mapError(
        (cause) => new SavedDraftError({ operation: "recover", message: cause.message }),
      ),
    );
  if (active?.pending || active?.streaming || (persisted?.messageCount ?? 0) > 0)
    return yield* new SavedDraftError({
      operation: "recover",
      message: "Pi already has an accepted turn; refresh the saved Draft instead",
    });
  return yield* storage.release(sessionId, expectedRevision);
});

export const create = Effect.fn("SavedDrafts.create")(function* (input: {
  readonly projectPath: string;
  readonly title: string;
  readonly text: string;
  readonly attachments: SavedDraft["attachments"];
  readonly configuration?: SavedDraft["configuration"];
  readonly sessionId?: string;
  readonly createdAt?: string;
  readonly modifiedAt?: string;
  readonly labelIds?: ReadonlyArray<string>;
  readonly resolved?: boolean;
}) {
  yield* requireProject(input.projectPath);
  const now = new Date().toISOString();
  const record: SavedDraft = {
    sessionId: input.sessionId ?? crypto.randomUUID(),
    projectPath: input.projectPath,
    workingDirectory: input.projectPath,
    title: input.title,
    text: input.text,
    attachments: [...input.attachments],
    ...(input.configuration ? { configuration: input.configuration } : null),
    labelIds: [...(input.labelIds ?? [])],
    resolved: input.resolved ?? false,
    createdAt: input.createdAt ?? now,
    modifiedAt: input.modifiedAt ?? now,
    revision: 1,
    status: "saved",
  };
  return yield* (yield* SavedDraftStorage).create(record);
});

export const update = Effect.fn("SavedDrafts.update")(function* (
  record: SavedDraft,
  expectedRevision: number,
) {
  yield* requireProject(record.projectPath);
  return yield* (yield* SavedDraftStorage).update(
    { ...record, modifiedAt: new Date().toISOString() },
    expectedRevision,
  );
});

export const remove = Effect.fn("SavedDrafts.remove")(function* (
  sessionId: string,
  expectedRevision: number,
) {
  yield* (yield* SavedDraftStorage).remove(sessionId, expectedRevision);
});

/** The durable claim precedes Pi work. Unknown acceptance remains claimed, never blindly replayed. */
export const activate = Effect.fn("SavedDrafts.activate")(function* (input: {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly workingDirectory?: string;
  readonly worktreeName?: string;
}) {
  const storage = yield* SavedDraftStorage;
  const existing = (yield* storage.list()).find((record) => record.sessionId === input.sessionId);
  if (!existing)
    return yield* new SavedDraftError({ operation: "activate", message: "Saved Draft not found" });
  yield* requireProject(existing.projectPath);
  if (input.workingDirectory && input.worktreeName)
    return yield* new SavedDraftError({
      operation: "activate",
      message: "Choose a Working Directory or a new Managed Worktree, not both",
    });
  if (input.workingDirectory && !input.worktreeName) {
    const locations = yield* projectSessionLocations.locations();
    if (
      !locations.some(
        (location) =>
          location.projectPath === existing.projectPath &&
          location.workingDirectory === input.workingDirectory,
      )
    )
      return yield* new SavedDraftError({
        operation: "activate",
        message: "Working Directory does not belong to this Project",
      });
  }
  const claimed = yield* storage.claim(
    input.sessionId,
    input.expectedRevision,
    input.workingDirectory ?? existing.projectPath,
  );
  const worktree = input.worktreeName
    ? yield* managedWorktrees
        .create({
          projectPath: claimed.projectPath,
          worktreeName: input.worktreeName,
          backgroundSetup: true,
        })
        .pipe(Effect.tapError(() => storage.release(claimed.sessionId, claimed.revision)))
    : undefined;
  const actual = worktree
    ? yield* storage.assignWorkingDirectory(
        claimed.sessionId,
        claimed.revision,
        worktree.worktreePath,
      )
    : claimed;
  const workingDirectory = actual.workingDirectory;
  yield* projectSessionOperations.start({
    sessionId: claimed.sessionId,
    projectPath: claimed.projectPath,
    workingDirectory,
    text: claimed.text,
    attachments: claimed.attachments,
    renderUserMessageAsMarkdown: true,
    name: claimed.title,
    ...(claimed.configuration ? { configuration: claimed.configuration } : null),
    ...(claimed.labelIds.length ? { labelIds: claimed.labelIds } : null),
  });
  const completed = yield* storage.complete(actual.sessionId, actual.revision);
  return {
    record: completed,
    workingDirectory,
    ...(worktree ? { managedWorktree: worktree } : null),
  };
});
