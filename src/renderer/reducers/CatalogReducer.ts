import { applySnapshot, batch, toSnapshot, type Snapshot } from "r-state-tree";
import { Project } from "../models/Project";
import { SessionSummary } from "../models/SessionSummary";
import { CakeChatSummary } from "../models/CakeChatSummary";
import type {
  CakeChatCatalogUpdate,
  ProjectCatalogUpdate,
  SessionCatalogUpdate,
} from "../../contracts/application/catalog-data";
import type { ProjectSessionCatalogQuery } from "../../contracts/project-sessions/project-session-data";
import type {
  CakeChatCatalogQuery,
  CakeChatSummary as CakeChatSummaryValue,
} from "../../contracts/cake-chats/cake-chat-data";
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
    const createdProjects =
      change._tag === "Replaced"
        ? projects.filter((project) => startsTodoList(model.find(project.path), project))
        : [];
    batch(() => {
      applySnapshot(model, { projects: [...projects] });
      for (const project of createdProjects) model.find(project.path)!.todoCreationRevision += 1;
    });
    return;
  }
  const event = change;
  if (event._tag === "ActivityChanged") {
    model.runningProjectPaths.splice(
      0,
      model.runningProjectPaths.length,
      ...event.runningProjectPaths,
    );
    return;
  }
  batch(() => {
    if (event._tag === "Upserted") {
      const existing = model.find(event.project.path);
      if (existing) {
        const created = startsTodoList(existing, event.project);
        applySnapshot(existing, event.project);
        if (created) existing.todoCreationRevision += 1;
      } else model.projects.push(Project.create(event.project));
    } else {
      const index = model.projects.findIndex((project) => project.path === event.path);
      if (index >= 0) model.projects.splice(index, 1);
    }
  });
}

/** Done items still belong to the list. Only an addition to a known empty list qualifies. */
function startsTodoList(existing: Project | undefined, incoming: { todos?: Project["todos"] }) {
  return existing?.todos.items.length === 0 && (incoming.todos?.items.length ?? 0) > 0;
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
    const incomingIds = new Set(incomingSessionIds);
    // Capture membership once, before any structural writes invalidate derived lookups.
    const existingById = new Map(model.sessions.map((session) => [session.sessionId, session]));
    for (const session of incoming) {
      const existing = existingById.get(session.sessionId);
      if (existing && existing.projectPath !== session.projectPath)
        throw new CatalogIdentityCollisionError("Session ID", [session.sessionId], {
          context: `snapshot for ${query.projectPath}`,
        });
    }
    // Active/resolved observations arrive independently. Reuse the same identity
    // when the arriving lane supersedes an opposite-lane pre-transition summary.
    // Consumers own ordering; metadata-only snapshots must not rewrite membership.
    batch(() => {
      const originalLength = model.sessions.length;
      const updated: Array<{
        session: SessionSummary;
        snapshot: Snapshot<SessionSummary>;
      }> = [];
      const removed: Array<{ index: number; session: SessionSummary }> = [];
      try {
        for (const session of incoming) {
          const existing = existingById.get(session.sessionId);
          if (existing) {
            updated.push({ session: existing, snapshot: toSnapshot(existing) });
            applySnapshot(existing, session);
          } else model.sessions.push(SessionSummary.create(session));
        }
        for (let index = originalLength - 1; index >= 0; index -= 1) {
          const session = model.sessions[index]!;
          if (belongsToGroup(session) && !incomingIds.has(session.sessionId)) {
            removed.push({ index, session });
            model.sessions.splice(index, 1);
          }
        }
        if (update._tag === "Snapshot" && query.resolved) {
          model.resolvedHasMoreByProject[query.projectPath] = update.hasMore ?? false;
          if (update.total === undefined) delete model.resolvedTotalByProject[query.projectPath];
          else model.resolvedTotalByProject[query.projectPath] = update.total;
        }
      } catch (error) {
        // batch is not a transaction. Keep rollback scoped to touched rows, not a
        // serialized copy of every Project, and restore the original array/order.
        for (const { index, session } of removed.reverse())
          model.sessions.splice(index, 0, session);
        const appended = model.sessions.splice(
          originalLength,
          model.sessions.length - originalLength,
        );
        for (const session of appended) session[Symbol.dispose]();
        for (const { session, snapshot } of updated.reverse()) applySnapshot(session, snapshot);
        throw error;
      }
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
    for (const session of incoming) {
      const existing = model.find(session.sessionId);
      if (existing) applySnapshot(existing, session);
      else model.sessions.push(SessionSummary.create(session));
    }
    if (event._tag === "Removed" || event._tag === "RemovedBatch") {
      const removedIds = new Set(event._tag === "Removed" ? [event.sessionId] : event.sessionIds);
      for (let index = model.sessions.length - 1; index >= 0; index -= 1) {
        const session = model.sessions[index]!;
        if (removedIds.has(session.sessionId) && belongsToGroup(session))
          model.sessions.splice(index, 1);
      }
    } else if (event._tag === "ActivityChanged") {
      const existing = model.find(event.sessionId);
      if (existing && belongsToGroup(existing)) {
        existing.running = event.running;
        if (event.workingStartedAt !== undefined)
          existing.workingStartedAt = event.workingStartedAt ?? undefined;
        if (event.recoveryIssue !== undefined)
          existing.recoveryIssue = event.recoveryIssue ?? undefined;
        if (event.latestTurnOutcome !== undefined)
          existing.latestTurnOutcome = event.latestTurnOutcome ?? undefined;
        if (event.unread !== undefined) existing.unread = event.unread;
        if (event.modifiedAt && event.modifiedAt > existing.modifiedAt)
          existing.modifiedAt = event.modifiedAt;
      }
    } else if (event._tag === "TitleChanged") {
      const existing = model.find(event.sessionId);
      if (existing && belongsToGroup(existing)) existing.title = event.title;
    } else if (event._tag === "StatusChanged") {
      const existing = model.find(event.sessionId);
      if (existing && belongsToGroup(existing)) {
        existing.resolved = event.resolved;
        existing.unread = event.unread;
      }
    }
  });
}

/** Exact metadata is not proof that the passive catalog has finished its initial scan. */
export function applyCakeChatLookup(model: CakeChatCatalog, session: CakeChatSummaryValue) {
  batch(() => {
    upsertCakeChatSummary(model, session);
    model.sessions.sort(compareSessionSummaries);
  });
}

function upsertCakeChatSummary(model: CakeChatCatalog, session: CakeChatSummaryValue) {
  const existing = model.find(session.sessionId);
  if (existing) applySnapshot(existing, session);
  else model.sessions.push(CakeChatSummary.create(session));
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
      upsertCakeChatSummary(model, event.session);
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
