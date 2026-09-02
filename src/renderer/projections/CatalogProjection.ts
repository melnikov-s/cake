import { applySnapshot, toSnapshot } from "r-state-tree";
import type { ProjectRecord } from "../../domain/application-data";
import type {
  CakeChatCatalogUpdate,
  ProjectCatalogUpdate,
  SessionCatalogUpdate,
} from "../../domain/catalog-data";
import type { CakeChatCatalog } from "../models/CakeChatCatalog";
import type { ProjectCatalog } from "../models/ProjectCatalog";
import type { SessionCatalog } from "../models/SessionCatalog";

export function applyProjectCatalogUpdate(model: ProjectCatalog, update: ProjectCatalogUpdate) {
  let projects: ProjectRecord[] = model.projects.map((project) => ({
    path: project.path,
    name: project.name,
    addedAt: project.addedAt,
    lastOpenedAt: project.lastOpenedAt,
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

export function applySessionCatalogUpdate(model: SessionCatalog, update: SessionCatalogUpdate) {
  if (update._tag === "Event" && update.event._tag === "StatusChanged") {
    const session = model.find(update.event.sessionId);
    if (!session) return;
    applySnapshot(session, {
      ...toSnapshot(session),
      resolved: update.event.resolved,
      unread: update.event.unread,
    });
    model.sessions.sort(compareSessionSummaries);
    return;
  }
  let sessions = model.sessions.map((session) => toSnapshot(session));
  if (update._tag === "Snapshot") sessions = [...update.sessions];
  else {
    const event = update.event;
    if (event._tag === "Replaced") sessions = [...event.sessions];
    else if (event._tag === "Upserted") {
      const index = sessions.findIndex((session) => session.sessionId === event.session.sessionId);
      if (index >= 0) sessions[index] = event.session;
      else sessions.push(event.session);
    } else if (event._tag === "Removed")
      sessions = sessions.filter((session) => session.sessionId !== event.sessionId);
    else
      sessions = sessions.map((session) =>
        session.sessionId === event.sessionId
          ? { ...session, resolved: event.resolved, unread: event.unread }
          : session,
      );
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

export function applyCakeChatCatalogUpdate(model: CakeChatCatalog, update: CakeChatCatalogUpdate) {
  const sessions = update._tag === "Snapshot" ? update.sessions : update.event.sessions;
  assertUnique(
    sessions.map((session) => session.sessionId),
    "Cake Chat Session ID",
  );
  applySnapshot(model, { loaded: true, sessions: [...sessions] });
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
