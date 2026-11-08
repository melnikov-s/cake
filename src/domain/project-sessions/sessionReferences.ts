import { Effect, Option, Stream } from "effect";
import {
  CAKE_CHAT_SESSION_ID,
  SESSION_ASSISTANT_ID,
  isCakeChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { CakeChatDurable } from "../../services/pi-durable/CakeChatDurable";
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
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import {
  familyMember,
  familyMemberIds,
} from "../../contracts/session-families/session-family-document";
import type { ProjectSessionArchiveMetadata } from "../../services/storage/SessionArchiveStorage";
import type { ProjectSessionLocation } from "../../contracts/project-sessions/project-session-data";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import * as projectSessionLocations from "./projectSessionLocations";
import * as metadata from "./projectSessionMetadata";

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
export const discover = Effect.fn("SessionReferences.discover")(
  function* (projectPath?: string) {
    const sessions = yield* CakeSessionRuntimes;
    const archive = yield* SessionArchiveStorage;
    const families = yield* SessionFamilyStorage;
    const application = yield* ApplicationState;
    const locations = (yield* projectSessionLocations.locations({ includeInactive: true })).filter(
      (location) => projectPath === undefined || location.projectPath === projectPath,
    );
    const projects = application
      .snapshot()
      .projects.filter((project) => projectPath === undefined || project.path === projectPath);
    const roster = new Map<string, SessionReferenceEntry>();
    const allFamilies = yield* families.state();
    const familyState = {
      ...allFamilies,
      families: allFamilies.families.filter(
        (family) => projectPath === undefined || family.projectPath === projectPath,
      ),
    };
    const archives = new Map<string, ProjectSessionArchiveMetadata>();
    const routes = new Map<string, ProjectSessionLocation[]>();
    const idsByLocation = new Map<ProjectSessionLocation, ReadonlySet<string>>();
    for (const project of projects) {
      const sessionId = projectChatSessionId(project.path);
      roster.set(sessionId, { sessionId, title: `${project.name} / Project Chat` });
    }
    for (const family of familyState.families)
      for (const sessionId of familyMemberIds(family)) roster.set(sessionId, { sessionId });
    for (const project of projects)
      for (const entry of yield* Stream.runCollect(archive.resolvedProjects(project.path))) {
        roster.set(entry.sessionId, { sessionId: entry.sessionId });
        archives.set(entry.sessionId, entry);
      }
    for (const location of locations) {
      const ids = yield* Stream.runCollect(
        sessions.sessionIds({
          workingDirectory: location.workingDirectory,
          sessionDirectory: location.sessionDirectory,
        }),
      );
      idsByLocation.set(location, new Set(ids));
      for (const sessionId of ids) {
        roster.set(sessionId, { sessionId });
        const candidates = routes.get(sessionId) ?? [];
        candidates.push(location);
        routes.set(sessionId, candidates);
      }
    }
    const storage = yield* Effect.serviceOption(SavedDraftStorage);
    const drafts = (Option.isSome(storage) ? yield* storage.value.list() : []).filter(
      (draft) => projectPath === undefined || draft.projectPath === projectPath,
    );
    for (const draft of drafts)
      roster.set(draft.sessionId, { sessionId: draft.sessionId, title: draft.title });
    return {
      roster: [...roster.values()],
      locations,
      familyState,
      archives,
      routes,
      idsByLocation,
      drafts,
    };
  },
  (effect, _projectPath?: string) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new ProjectSessionError({
            operation: "sessionReferenceCatalog",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    ),
);

/** Identity-only consumers discard request-local routing evidence, never transcript content. */
export const catalog = Effect.fn("SessionReferences.catalog")(function* () {
  return (yield* discover()).roster;
});

/** Explicit hierarchy, never a creator link or an omitted-target default. Resolve at admission. */
const parentTarget = Effect.fn("SessionReferences.parentTarget")(function* (
  callerSessionId?: string,
) {
  const fail = (message: string) =>
    new ProjectSessionError({ operation: "resolveSessionReference", message });
  if (callerSessionId === undefined) return yield* fail("parent requires a calling conversation");
  if (callerSessionId === SESSION_ASSISTANT_ID) {
    const durable = yield* Effect.serviceOption(CakeChatDurable);
    const target = Option.isSome(durable)
      ? yield* durable.value.assistantContextSessionId()
      : undefined;
    if (!target || target === SESSION_ASSISTANT_ID)
      return yield* fail("Companion invoking context is unavailable");
    // Context is a concrete identity, not another alias; the operation still validates access/existence.
    const canonical = resolveSessionReference(target, []);
    if (!canonical.ok)
      return yield* fail("Companion invoking context has no valid session identity");
    return canonical.sessionId;
  }
  if (isCakeChatSessionId(callerSessionId)) return CAKE_CHAT_SESSION_ID;
  const family = yield* (yield* SessionFamilyStorage).familyForMember(callerSessionId);
  const member = family && familyMember(family, callerSessionId);
  if (member?.parentSessionId) return member.parentSessionId;
  const projectPath =
    family?.projectPath ??
    (yield* metadata.findLocation({ sessionId: callerSessionId })).projectPath;
  return projectChatSessionId(projectPath);
});

export const resolve = Effect.fn("SessionReferences.resolve")(function* (
  reference: string,
  callerSessionId?: string,
) {
  if (reference === "parent") return yield* parentTarget(callerSessionId);
  // Canonical identities still undergo existence/access checks at their authoritative route.
  // Only suffixes and other roster-bound references need global identity discovery.
  const canonical = resolveSessionReference(reference, []);
  if (canonical.ok) return canonical.sessionId;
  return yield* resolveIn(reference, yield* catalog());
});

/** Cosmetic result projection must not discover global storage. Scoped callers that already
 * own a roster can shorten with projectIn; general results keep canonical routing identities.
 */
export const project = Effect.fn("SessionReferences.project")((value: JsonValue) =>
  Effect.sync(() => projectSessionReferences(value)),
);
