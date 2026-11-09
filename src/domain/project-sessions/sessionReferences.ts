import { Effect, Option, Stream } from "effect";
import {
  cakeChatSideChatConversationId,
  SESSION_ASSISTANT_ID,
  isCakeChatSessionId,
  isProjectChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { CakeChatDurable } from "../../services/pi-durable/CakeChatDurable";
import { DiscussionSessionEnvironment } from "../../services/discussion-sessions/DiscussionSessionEnvironment";
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
import * as discussionReferences from "../discussion-sessions/discussionSessionReferences";
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

/** Resolve recorded provenance, never infer an owner from the working directory. */
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
  if (isCakeChatSessionId(callerSessionId))
    return yield* fail("This permanent chat has no parent; provide an explicit sessionId.");
  const storage = yield* SessionFamilyStorage;
  const family = yield* storage.familyForMember(callerSessionId);
  const member = family && familyMember(family, callerSessionId);
  const state = yield* storage.state();
  const target =
    member?.parentSessionId ??
    state.sessionParents?.find((item) => item.sessionId === callerSessionId)?.parentSessionId ??
    state.spawnedSessions.find((item) => item.sessionId === callerSessionId)?.requester.sessionId ??
    (cakeChatSideChatConversationId(callerSessionId) !== undefined
      ? (yield* discussionReferences.lookup(callerSessionId)).record.parentSessionId
      : undefined);
  if (!target || target === callerSessionId)
    return yield* fail("No recorded parent is available; provide an explicit sessionId.");
  return target;
});

/** Omitted sends and explicit parent agree. Do not restore a resolved parent as a side effect. */
export const messageTarget = Effect.fn("SessionReferences.messageTarget")(function* (
  reference: string | undefined,
  callerSessionId: string,
) {
  if (reference !== undefined && reference !== "parent")
    return yield* resolve(reference, callerSessionId);
  const target = yield* parentTarget(callerSessionId);
  if (target === callerSessionId)
    return yield* new ProjectSessionError({
      operation: "resolveSessionReference",
      message: "A session thread requires two different sessions.",
    });
  if (
    isProjectChatSessionId(target) &&
    !(yield* ApplicationState)
      .snapshot()
      .projects.some((project) => projectChatSessionId(project.path) === target)
  )
    return yield* new ProjectSessionError({
      operation: "resolveSessionReference",
      message: "The recorded parent Project Chat is unavailable; provide an explicit sessionId.",
    });
  const sideChat = (yield* (yield* SessionFamilyStorage).state()).sessionParents?.find(
    (item) => item.sessionId === target && item.kind === "side-chat",
  );
  let resolved = false;
  if (cakeChatSideChatConversationId(target) !== undefined)
    resolved = (yield* discussionReferences.lookup(target)).reference.resolved;
  else if (sideChat) {
    const environment = yield* Effect.serviceOption(DiscussionSessionEnvironment);
    if (Option.isNone(environment))
      return yield* new ProjectSessionError({
        operation: "resolveSessionReference",
        message: "Parent Side Chat metadata is unavailable; provide an explicit sessionId.",
      });
    const location = yield* metadata.findLocation({ sessionId: sideChat.parentSessionId });
    const record = (yield* environment.value.list(
      location.workingDirectory,
      sideChat.parentSessionId,
    )).find((record) => record.sidecarSessionId === target);
    if (!record)
      return yield* new ProjectSessionError({
        operation: "resolveSessionReference",
        message: "The recorded parent Side Chat is unavailable; provide an explicit sessionId.",
      });
    resolved = record.status === "resolved";
  } else if (!isCakeChatSessionId(target))
    resolved = (yield* metadata.lookup({ sessionId: target })).resolved;
  if (resolved)
    return yield* new ProjectSessionError({
      operation: "resolveSessionReference",
      message: "The recorded parent is resolved; provide an explicit sessionId.",
    });
  return target;
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
