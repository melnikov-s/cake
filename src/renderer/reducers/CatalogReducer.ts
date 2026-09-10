import { applySnapshot, batch, toSnapshot } from "r-state-tree";
import { Project } from "../models/Project";
import { SessionSummary } from "../models/SessionSummary";
import { CakeChatSummary } from "../models/CakeChatSummary";
import type {
  CakeChatCatalogUpdate,
  ProjectCatalogUpdate,
  SessionCatalogUpdate,
} from "../../domain/application/catalog-data";
import type { ProjectSessionCatalogQuery } from "../../domain/project-sessions/project-session-data";
import type { CakeChatCatalogQuery } from "../../domain/cake-chats/cake-chat-data";
import type { CakeChatCatalog } from "../models/CakeChatCatalog";
import type { ProjectCatalog } from "../models/ProjectCatalog";
import type { SessionCatalog } from "../models/SessionCatalog";

export function applyProjectCatalogUpdate(model: ProjectCatalog, update: ProjectCatalogUpdate) {
  const change = update._tag === "Snapshot" ? update : update.event;
  if (change._tag === "Snapshot" || change._tag === "Replaced") {
    const projects = change.projects;
    assertUnique(
      projects.map((project) => project.path),
      "Project path",
    );
    applySnapshot(model, { projects: [...projects] });
    return;
  }
  const event = change;
  batch(() => {
    if (event._tag === "Upserted") {
      const existing = model.find(event.project.path);
      if (existing) applySnapshot(existing, event.project);
      else model.projects.push(Project.create(event.project));
    } else {
      const index = model.projects.findIndex((project) => project.path === event.path);
      if (index >= 0) model.projects.splice(index, 1);
    }
  });
}

export function applySessionCatalogGroupUpdate(
  model: SessionCatalog,
  query: ProjectSessionCatalogQuery,
  update: SessionCatalogUpdate,
) {
  const belongsToGroup = (session: {
    readonly projectPath?: string | null;
    readonly resolved?: boolean | null;
  }) => session.projectPath === query.projectPath && session.resolved === query.resolved;
  const change = update._tag === "Snapshot" ? update : update.event;
  if (change._tag === "Snapshot" || change._tag === "Replaced") {
    const incoming = change.sessions;
    const incomingSessionIds = incoming.map((session) => session.sessionId);
    assertUnique(
      incomingSessionIds,
      "Session ID",
      `${query.resolved ? "resolved" : "active"} snapshot for ${query.projectPath}`,
    );
    const incomingById = new Map(incoming.map((session) => [session.sessionId, session]));
    const incomingIds = new Set(incomingById.keys());
    const retained = model.sessions.filter((session) => !belongsToGroup(session));
    for (const session of retained) {
      const replacement = incomingById.get(session.sessionId);
      if (!replacement) continue;
      if (session.projectPath !== replacement.projectPath)
        throw new CatalogIdentityCollisionError("Session ID", [session.sessionId], {
          context: `snapshot for ${query.projectPath}`,
        });
    }
    // Active and resolved observers subscribe and scan independently. A resolve can
    // therefore leave one lane's pre-transition Snapshot in the Model when the
    // other lane's post-transition Snapshot arrives. They describe one identity,
    // so the arriving lane observation supersedes the stale opposite-lane summary.
    const sessions = [
      ...retained
        .filter((session) => !incomingIds.has(session.sessionId))
        .map((session) => toSnapshot(session)),
      ...incoming,
    ];
    assertUnique(
      sessions
        .map((session) => session.sessionId)
        .filter((id): id is string => typeof id === "string"),
      "Session ID",
      `merged snapshot for ${query.projectPath}`,
    );
    sessions.sort(compareSessionSummaries);
    batch(() => {
      applySnapshot(model, {
        sessions,
        resolvedHasMoreByProject: { ...model.resolvedHasMoreByProject },
      });
      if (update._tag === "Snapshot" && query.resolved)
        model.resolvedHasMoreByProject[query.projectPath] = update.hasMore ?? false;
    });
    return;
  }
  const event = change;
  const incoming =
    event._tag === "Upserted"
      ? [event.session]
      : event._tag === "UpsertedBatch"
        ? event.sessions
        : [];
  assertUnique(
    incoming.map((session) => session.sessionId),
    "Session ID",
    `${query.resolved ? "resolved" : "active"} event for ${query.projectPath}`,
  );
  for (const session of incoming) {
    const existing = model.find(session.sessionId);
    if (existing && existing.projectPath !== session.projectPath)
      throw new CatalogIdentityCollisionError("Session ID", [session.sessionId], {
        context: `event for ${query.projectPath}`,
      });
  }
  batch(() => {
    let needsSort = false;
    for (const session of incoming) {
      const existing = model.find(session.sessionId);
      if (existing) {
        needsSort ||=
          existing.resolved !== session.resolved || existing.modifiedAt !== session.modifiedAt;
        applySnapshot(existing, session);
      } else {
        model.sessions.push(SessionSummary.create(session));
        needsSort = true;
      }
    }
    if (event._tag === "Removed" || event._tag === "RemovedBatch") {
      const removedIds = new Set(event._tag === "Removed" ? [event.sessionId] : event.sessionIds);
      for (let index = model.sessions.length - 1; index >= 0; index -= 1) {
        const session = model.sessions[index]!;
        if (removedIds.has(session.sessionId) && belongsToGroup(session)) {
          model.sessions.splice(index, 1);
          needsSort = true;
        }
      }
    } else if (event._tag === "StatusChanged") {
      const existing = model.find(event.sessionId);
      if (existing && belongsToGroup(existing)) {
        needsSort ||= existing.resolved !== event.resolved;
        existing.resolved = event.resolved;
        existing.unread = event.unread;
      }
    }
    if (needsSort) model.sessions.sort(compareSessionSummaries);
  });
}

export function applyCakeChatCatalogGroupUpdate(
  model: CakeChatCatalog,
  query: CakeChatCatalogQuery,
  update: CakeChatCatalogUpdate,
) {
  const change = update._tag === "Snapshot" ? update : update.event;
  if (change._tag === "Snapshot" || change._tag === "Replaced") {
    const incoming = change.sessions;
    const sessions = [
      ...model.sessions
        .filter((session) => session.resolved !== query.resolved)
        .map((session) => toSnapshot(session)),
      ...incoming,
    ];
    assertUnique(
      sessions
        .map((session) => session.sessionId)
        .filter((id): id is string => typeof id === "string"),
      "Cake Chat Session ID",
    );
    sessions.sort(compareSessionSummaries);
    applySnapshot(model, {
      loaded: true,
      resolvedHasMore:
        update._tag === "Snapshot" && query.resolved
          ? (update.hasMore ?? false)
          : model.resolvedHasMore,
      sessions,
    });
    return;
  }
  const event = change;
  batch(() => {
    if (event._tag === "Upserted") {
      const existing = model.find(event.session.sessionId);
      if (existing) applySnapshot(existing, event.session);
      else model.sessions.push(CakeChatSummary.create(event.session));
    } else if (event._tag === "Removed") {
      const index = model.sessions.findIndex((session) => session.sessionId === event.sessionId);
      if (index >= 0) model.sessions.splice(index, 1);
    } else {
      const existing = model.find(event.sessionId);
      if (existing) existing.resolved = event.resolved;
    }
    model.sessions.sort(compareSessionSummaries);
    model.loaded = true;
  });
}

const compareSessionSummaries = (
  left: { readonly resolved?: boolean | null; readonly modifiedAt?: string | null },
  right: { readonly resolved?: boolean | null; readonly modifiedAt?: string | null },
) => {
  const leftResolved = left.resolved === true;
  const rightResolved = right.resolved === true;
  if (leftResolved !== rightResolved) return leftResolved ? 1 : -1;
  return (right.modifiedAt ?? "").localeCompare(left.modifiedAt ?? "");
};

export class CatalogIdentityCollisionError extends Error {
  readonly values: readonly string[];
  readonly context?: string;

  constructor(label: string, values: readonly string[], options?: { readonly context?: string }) {
    const uniqueValues = [...new Set(values)];
    super(
      `${label} collision: ${uniqueValues.join(", ")}${options?.context ? ` (${options.context})` : ""}`,
    );
    this.name = "CatalogIdentityCollisionError";
    this.values = uniqueValues;
    this.context = options?.context;
  }
}

function assertUnique(values: readonly string[], label: string, context?: string) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    else seen.add(value);
  }
  if (duplicates.size > 0)
    throw new CatalogIdentityCollisionError(label, [...duplicates], { context });
}
