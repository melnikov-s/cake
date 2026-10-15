import { Effect, Option, Stream } from "effect";
import {
  projectSessionReferences,
  resolveSessionReference,
  sessionReference,
} from "../../contracts/project-sessions/session-reference";
import { ProjectSessionError } from "../../contracts/project-sessions/project-session-data";
import type { JsonValue } from "../../contracts/serialization/json-contract";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { SavedDraftStorage } from "../../services/storage/SavedDraftStorage";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { SessionFamilyStorage, familyMemberIds } from "../../services/storage/SessionFamilyStorage";
import * as projectSessionLocations from "./projectSessionLocations";

export interface SessionReferenceEntry {
  readonly sessionId: string;
  readonly title?: string;
}

/** Explicit rosters let Workboards and reminders use their already-authorized membership. */
export const resolveIn = Effect.fn("SessionReferences.resolveIn")(function* (
  reference: string,
  roster: readonly SessionReferenceEntry[],
) {
  const result = resolveSessionReference(
    reference,
    roster.map((entry) => entry.sessionId),
  );
  if (!result.ok)
    return yield* new ProjectSessionError({
      operation: "resolveSessionReference",
      message: result.error,
    });
  return result.sessionId;
});

export function projectIn(value: JsonValue, roster: readonly SessionReferenceEntry[]): JsonValue {
  return projectSessionReferences(
    value,
    roster.map((entry) => entry.sessionId),
  );
}

export function labelIn(sessionId: string, roster: readonly SessionReferenceEntry[]): string {
  const ref = sessionReference(
    sessionId,
    roster.map((entry) => entry.sessionId),
  );
  const title = roster.find((entry) => entry.sessionId === sessionId)?.title;
  return title ? `${ref} (${title})` : ref;
}

/** Identity-only roster, not a sidebar catalog. Never open transcripts just to resolve a suffix.
 * Resolved sessions stay in their Pi directory; archived project metadata also retains identities
 * whose worktree no longer exists. Include inactive family bindings without acquiring runtimes.
 */
export const catalog = Effect.fn("SessionReferences.catalog")(
  function* () {
    const sessions = yield* CakeSessionRuntimes;
    const archive = yield* SessionArchiveStorage;
    const families = yield* SessionFamilyStorage;
    const application = yield* ApplicationState;
    const locations = yield* projectSessionLocations.locations({ includeInactive: true });
    const roster = new Map<string, SessionReferenceEntry>();
    for (const family of yield* families.list())
      for (const sessionId of familyMemberIds(family)) roster.set(sessionId, { sessionId });
    for (const project of application.snapshot().projects)
      for (const entry of yield* Stream.runCollect(archive.resolvedProjects(project.path)))
        roster.set(entry.sessionId, { sessionId: entry.sessionId });
    for (const location of locations) {
      const ids = yield* Stream.runCollect(
        sessions.sessionIds({
          workingDirectory: location.workingDirectory,
          sessionDirectory: location.sessionDirectory,
        }),
      );
      for (const sessionId of ids) roster.set(sessionId, { sessionId });
    }
    const drafts = yield* Effect.serviceOption(SavedDraftStorage);
    if (Option.isSome(drafts))
      for (const draft of yield* drafts.value.list())
        roster.set(draft.sessionId, { sessionId: draft.sessionId, title: draft.title });
    return [...roster.values()];
  },
  Effect.mapError(
    (cause) =>
      new ProjectSessionError({
        operation: "sessionReferenceCatalog",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  ),
);

export const resolve = Effect.fn("SessionReferences.resolve")(function* (reference: string) {
  return yield* resolveIn(reference, yield* catalog());
});

export const project = Effect.fn("SessionReferences.project")(function* (value: JsonValue) {
  const candidate = projectSessionReferences(value, []);
  if (JSON.stringify(candidate) === JSON.stringify(value)) return value;
  return projectIn(value, yield* catalog());
});
