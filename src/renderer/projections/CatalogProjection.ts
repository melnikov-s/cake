import { applySnapshot, toSnapshot } from "r-state-tree";
import type { ProjectRecord } from "../../domain/application-data";
import type {
  CakeChatCatalogUpdate,
  ProjectCatalogUpdate,
  SessionCatalogUpdate,
} from "../../domain/catalog-data";
import type { ProjectSessionCatalogQuery } from "../../domain/project-session-data";
import type { CakeChatCatalogQuery } from "../../domain/cake-chat-data";
import type { CakeChatCatalog } from "../models/CakeChatCatalog";
import type { ProjectCatalog } from "../models/ProjectCatalog";
import type { SessionCatalog } from "../models/SessionCatalog";

export function applyProjectCatalogUpdate(model: ProjectCatalog, update: ProjectCatalogUpdate) {
  let projects: ProjectRecord[] = model.projects.map((project) => ({
    path: project.path,
    name: project.name,
    addedAt: project.addedAt,
    lastOpenedAt: project.lastOpenedAt,
    settings: { ...project.settings },
  }));
  if (update._tag === "Snapshot") projects = [...update.projects];
  else {
    const event = update.event;
    if (event._tag === "Replaced") projects = [...event.projects];
    else if (event._tag === "Upserted") {
      const index = projects.findIndex((project) => project.path === event.project.path);
      if (index >= 0) projects[index] = event.project;
      else projects.push(event.project);
    } else projects = projects.filter((project) => project.path !== event.path);
  }
  assertUnique(
    projects.map((project) => project.path),
    "Project path",
  );
  applySnapshot(model, { projects });
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
  let sessions = model.sessions.map((session) => toSnapshot(session));
  if (update._tag === "Snapshot") {
    sessions = [...sessions.filter((session) => !belongsToGroup(session)), ...update.sessions];
  } else {
    const event = update.event;
    if (event._tag === "Replaced") {
      sessions = [...sessions.filter((session) => !belongsToGroup(session)), ...event.sessions];
    } else if (event._tag === "Upserted") {
      const existing = sessions.find((session) => session.sessionId === event.session.sessionId);
      if (existing && existing.projectPath !== event.session.projectPath)
        throw new Error(`Session ID collision: ${event.session.sessionId}`);
      sessions = sessions.filter((session) => session.sessionId !== event.session.sessionId);
      sessions.push(event.session);
    } else if (event._tag === "UpsertedBatch") {
      const incomingIds = new Set(event.sessions.map((session) => session.sessionId));
      sessions = sessions.filter(
        (session) => !session.sessionId || !incomingIds.has(session.sessionId),
      );
      sessions.push(...event.sessions);
    } else if (event._tag === "Removed") {
      sessions = sessions.filter((session) => session.sessionId !== event.sessionId);
    } else {
      sessions = sessions.map((session) =>
        session.sessionId === event.sessionId && belongsToGroup(session)
          ? { ...session, resolved: event.resolved, unread: event.unread }
          : session,
      );
    }
  }
  sessions.sort(compareSessionSummaries);
  assertUnique(
    sessions
      .map((session) => session.sessionId)
      .filter((sessionId): sessionId is string => typeof sessionId === "string"),
    "Session ID",
  );
  applySnapshot(model, { sessions });
}

export function applyCakeChatCatalogGroupUpdate(
  model: CakeChatCatalog,
  query: CakeChatCatalogQuery,
  update: CakeChatCatalogUpdate,
) {
  let sessions = model.sessions.map((session) => toSnapshot(session));
  if (update._tag === "Snapshot") {
    sessions = [
      ...sessions.filter((session) => session.resolved !== query.resolved),
      ...update.sessions,
    ];
  } else {
    const event = update.event;
    if (event._tag === "Replaced") {
      sessions = [
        ...sessions.filter((session) => session.resolved !== query.resolved),
        ...event.sessions,
      ];
    } else if (event._tag === "Upserted") {
      sessions = sessions.filter((candidate) => candidate.sessionId !== event.session.sessionId);
      sessions.push(event.session);
    } else if (event._tag === "Removed")
      sessions = sessions.filter((session) => session.sessionId !== event.sessionId);
    else
      sessions = sessions.map((session) =>
        session.sessionId === event.sessionId ? { ...session, resolved: event.resolved } : session,
      );
  }
  sessions.sort(compareSessionSummaries);
  assertUnique(
    sessions
      .map((session) => session.sessionId)
      .filter((sessionId): sessionId is string => typeof sessionId === "string"),
    "Cake Chat Session ID",
  );
  applySnapshot(model, { loaded: true, sessions });
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

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} collision`);
}
