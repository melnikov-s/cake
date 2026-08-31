import { Context, Effect, Schema, Stream } from "effect";
import { Model, Store, batch, createStore, refStream, type StoreInstance } from "effect-state-tree";
import { CakeIpcClient } from "../../ipc/client/CakeIpcClient";
import type { ProjectSessionSummary as ProjectSessionSummaryValue } from "../../domain/project-session-data";
import type { SessionCatalogUpdate } from "../../domain/catalog-data";
import { ManagedWorktreeContext } from "../../services/project-sessions/ProjectSessionEnvironment";
import type { GlobalSessionSummary, SessionSnapshot } from "../../ipc/session-contract";
import type { WorktreeRecord } from "../../ipc/worktree-contract";
import { compareSessionSummariesForSidebar } from "../../utils/session-summary-order";
import { describeError } from "../error-details";
import {
  SessionSummary,
  type SessionCatalogEntry,
  type SessionSummary as SessionSummaryInstance,
} from "../models/SessionSummary";
import { SessionSummaryCollection } from "../models/SessionSummaryCollection";

const toEntry = (
  summary: ProjectSessionSummaryValue,
  draft = false,
  rendererOwned = false,
): SessionCatalogEntry => ({
  summary: { ...summary },
  draft,
  rendererOwned,
});

const fromLegacy = (summary: GlobalSessionSummary): SessionCatalogEntry => {
  const projected: ProjectSessionSummaryValue = {
    sessionId: summary.id,
    title: summary.title,
    createdAt: summary.created,
    modifiedAt: summary.modified,
    messageCount: summary.messageCount,
    resolved: summary.resolved,
    unread: summary.unread,
    projectPath: summary.projectPath ?? summary.workspacePath,
    projectName: summary.workspaceName,
    workingDirectory: summary.workspacePath,
  };
  if (summary.parentSessionId !== undefined)
    Object.assign(projected, { parentSessionId: summary.parentSessionId });
  if (summary.managedWorktree !== undefined)
    Object.assign(projected, { managedWorktree: summary.managedWorktree });
  return toEntry(projected, summary.draft ?? false);
};

const sortEntries = (entries: ReadonlyArray<SessionCatalogEntry>) =>
  [...entries].sort((left, right) =>
    compareSessionSummariesForSidebar(
      { messageCount: left.summary.messageCount, modified: left.summary.modifiedAt },
      { messageCount: right.summary.messageCount, modified: right.summary.modifiedAt },
    ),
  );

/** Window-lifetime flat Project Session catalog projection and its scoped RPC subscription. */
export const SessionCatalogStoreFactory = createStore(
  "SessionCatalogStore",
  Store.schema({
    managedWorktrees: Schema.Array(ManagedWorktreeContext),
    loading: Schema.Boolean,
    revision: Schema.Int,
    sourceRevision: Schema.Int,
    error: Schema.optional(Schema.String),
    errorDetails: Schema.optional(Schema.String),
  }),
  function* ({ self, autorun }) {
    const client = yield* CakeIpcClient;
    const projection = yield* SessionSummaryCollection.make({ sessions: [] }).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() => Effect.sync(() => projection[Symbol.dispose]()));
    let indexed = new Map<string, SessionSummaryInstance>();
    let grouped = new Map<string, readonly SessionSummaryInstance[]>();
    const rebuildIndexes = (sessions: ReadonlyArray<SessionSummaryInstance>) => {
      indexed = new Map(sessions.map((session) => [session.sessionId, session]));
      const nextGroups = new Map<string, SessionSummaryInstance[]>();
      for (const session of sessions) {
        const group = nextGroups.get(session.projectPath) ?? [];
        group.push(session);
        nextGroups.set(session.projectPath, group);
      }
      grouped = nextGroups;
    };
    const orderedSessions = () =>
      projection.sessions.value.flatMap((session) => {
        const found = indexed.get(session.identity.value);
        return found ? [found] : [];
      });

    const reconcile = Effect.fn("SessionCatalogStore.reconcile")(function* (
      entries: ReadonlyArray<SessionCatalogEntry>,
      sourceRevision?: number,
    ) {
      const sorted = sortEntries(entries);
      const seen = new Set<string>();
      for (const entry of sorted) {
        const id = entry.summary.sessionId;
        if (seen.has(id))
          return yield* Effect.fail(new Model.IdentityCollisionError(SessionSummary.schema, id));
        seen.add(id);
      }
      const current = indexed;
      const next: SessionSummaryInstance[] = [];
      const updates: Array<readonly [SessionSummaryInstance, SessionCatalogEntry]> = [];
      for (const entry of sorted) {
        const existing = current.get(entry.summary.sessionId);
        if (existing) {
          next.push(existing);
          updates.push([existing, entry]);
        } else {
          next.push(
            yield* SessionSummary.make({
              identity: entry.summary.sessionId,
              entry,
            }),
          );
        }
      }
      batch(() => {
        for (const [session, entry] of updates) session.update(entry);
        projection.replace(next);
        rebuildIndexes(next);
        if (sourceRevision !== undefined) self.sourceRevision.set(sourceRevision);
        self.revision.update((revision) => revision + 1);
      });
    });

    const currentEntries = () => orderedSessions().map((session) => session.entry.value);
    const entryFor = (sessionId: string) => indexed.get(sessionId);
    const managedWorktree = (workingDirectory: string) =>
      self.managedWorktrees.value.find((record) => record.worktreePath === workingDirectory) ??
      orderedSessions().find((session) => session.workspacePath === workingDirectory)
        ?.managedWorktree;

    const replaceRpc = (sessions: ReadonlyArray<ProjectSessionSummaryValue>, revision?: number) => {
      const listed = new Set(sessions.map((session) => session.sessionId));
      return reconcile(
        [
          ...sessions.map((session) => {
            const existing = entryFor(session.sessionId);
            return toEntry(session, existing?.draft ?? false);
          }),
          ...currentEntries().filter(
            (entry) => entry.rendererOwned && !listed.has(entry.summary.sessionId),
          ),
        ],
        revision,
      );
    };

    const reduce = Effect.fn("SessionCatalogStore.reduce")(function* (
      update: SessionCatalogUpdate,
    ) {
      if (update._tag === "Snapshot") {
        yield* replaceRpc(update.sessions, update.revision);
        return;
      }
      if (update.revision <= self.sourceRevision.value) return;
      const event = update.event;
      switch (event._tag) {
        case "Replaced":
          yield* replaceRpc(event.sessions, update.revision);
          return;
        case "Upserted": {
          const existing = entryFor(event.session.sessionId);
          const entries = currentEntries().filter(
            (entry) => entry.summary.sessionId !== event.session.sessionId,
          );
          entries.push(toEntry(event.session, existing?.draft ?? false));
          yield* reconcile(entries, update.revision);
          return;
        }
        case "Removed": {
          if (!entryFor(event.sessionId)) {
            self.sourceRevision.set(update.revision);
            return;
          }
          yield* reconcile(
            currentEntries().filter((entry) => entry.summary.sessionId !== event.sessionId),
            update.revision,
          );
          return;
        }
        case "StatusChanged": {
          const existing = entryFor(event.sessionId);
          if (!existing) {
            self.sourceRevision.set(update.revision);
            return;
          }
          batch(() => {
            existing.update({
              ...existing.entry.value,
              summary: {
                ...existing.entry.value.summary,
                resolved: event.resolved,
                unread: event.unread,
              },
            });
            self.sourceRevision.set(update.revision);
            self.revision.update((revision) => revision + 1);
          });
        }
      }
    });

    const setError = (error: unknown) => {
      const described = describeError(error, "Project Session catalog");
      batch(() => {
        self.error.set(described.message);
        self.errorDetails.set(described.details);
        self.loading.set(false);
      });
    };

    autorun(
      "observeCatalog",
      client.projectSessions.observeCatalog().pipe(
        Stream.runForEach((update) =>
          reduce(update).pipe(Effect.tap(() => Effect.sync(() => self.loading.set(false)))),
        ),
        Effect.catch((error) => Effect.sync(() => setError(error))),
      ),
    );

    const updateEntry = (
      sessionId: string,
      update: (entry: SessionCatalogEntry) => SessionCatalogEntry,
      sort = false,
    ) => {
      const session = entryFor(sessionId);
      if (!session) return false;
      session.update(update(session.entry.value));
      if (sort) {
        const sorted = [...orderedSessions()].sort(compareSessionSummariesForSidebar);
        projection.replace(sorted);
        rebuildIndexes(sorted);
      }
      self.revision.update((revision) => revision + 1);
      return true;
    };

    return {
      get sessions(): ReadonlyArray<SessionSummaryInstance> {
        return orderedSessions();
      },
      find(sessionId: string) {
        void self.revision.value;
        return entryFor(sessionId);
      },
      get sessionsById(): ReadonlyMap<string, SessionSummaryInstance> {
        void self.revision.value;
        return indexed;
      },
      get sessionsByProject(): ReadonlyMap<string, readonly SessionSummaryInstance[]> {
        void self.revision.value;
        return grouped;
      },
      projectSessions(projectPath: string) {
        void self.revision.value;
        return grouped.get(projectPath) ?? [];
      },
      managedWorktree,
      projectOfManagedWorktree(workingDirectory: string) {
        return managedWorktree(workingDirectory)?.projectPath;
      },
      resolvedWorktrees(projectPath: string) {
        const groups = new Map<string, SessionSummaryInstance[]>();
        for (const session of orderedSessions()) {
          const record = session.managedWorktree;
          if (session.projectPath !== projectPath || !record || record.state !== "landed") continue;
          const group = groups.get(record.worktreePath) ?? [];
          group.push(session);
          groups.set(record.worktreePath, group);
        }
        return [...groups.values()]
          .filter((sessions) => sessions.every((session) => session.resolved))
          .map((sessions) => sessions[0]!.managedWorktree!);
      },
      replace: Effect.fn("SessionCatalogStore.replace")(
        (sessions: readonly GlobalSessionSummary[]) => reconcile(sessions.map(fromLegacy)),
      ),
      applyWorkspace: Effect.fn("SessionCatalogStore.applyWorkspace")(function* (
        workspacePath: string,
        workspaceName: string,
        sessions: SessionSnapshot["sessions"],
        retainedSessionIds: readonly string[] = [],
      ) {
        const prior = new Map(
          currentEntries()
            .filter((entry) => entry.summary.workingDirectory === workspacePath)
            .map((entry) => [entry.summary.sessionId, entry]),
        );
        const retained = new Set(retainedSessionIds);
        const other = currentEntries().filter(
          (entry) => entry.summary.workingDirectory !== workspacePath,
        );
        const worktree = managedWorktree(workspacePath);
        const workspaceEntries = sessions.map((session) => {
          const previous = prior.get(session.id);
          const projected: ProjectSessionSummaryValue = {
            sessionId: session.id,
            title: session.title,
            createdAt: session.created,
            modifiedAt: session.modified,
            messageCount: session.messageCount,
            resolved: previous?.summary.resolved ?? session.resolved,
            unread: previous?.summary.unread ?? false,
            projectPath: worktree?.projectPath ?? workspacePath,
            projectName: workspaceName,
            workingDirectory: workspacePath,
          };
          if (session.parentSessionId !== undefined)
            Object.assign(projected, { parentSessionId: session.parentSessionId });
          if (worktree !== undefined) Object.assign(projected, { managedWorktree: worktree });
          return toEntry(projected, previous?.draft ?? session.draft ?? false);
        });
        const listed = new Set(workspaceEntries.map((entry) => entry.summary.sessionId));
        for (const [sessionId, entry] of prior)
          if (retained.has(sessionId) && !listed.has(sessionId)) workspaceEntries.push(entry);
        yield* reconcile([...other, ...workspaceEntries]);
      }),
      upsertPending: Effect.fn("SessionCatalogStore.upsertPending")(function* (
        sessionId: string,
        workspacePath: string,
        workspaceName: string,
        options: { draft?: boolean; resolved?: boolean } = {},
      ) {
        const existing = entryFor(sessionId);
        const now = new Date().toISOString();
        const worktree = managedWorktree(workspacePath);
        const summary: ProjectSessionSummaryValue = {
          sessionId,
          title: existing?.title ?? "New chat",
          createdAt: existing?.created ?? now,
          modifiedAt: now,
          messageCount: 0,
          resolved: options.resolved ?? existing?.resolved ?? false,
          unread: existing?.unread ?? false,
          projectPath: worktree?.projectPath ?? workspacePath,
          projectName: workspaceName,
          workingDirectory: workspacePath,
        };
        if (worktree !== undefined) Object.assign(summary, { managedWorktree: worktree });
        yield* reconcile([
          ...currentEntries().filter((entry) => entry.summary.sessionId !== sessionId),
          toEntry(summary, options.draft ?? existing?.draft ?? false, true),
        ]);
      }),
      noteManagedWorktree(record: WorktreeRecord) {
        const records = self.managedWorktrees.value.filter(
          (current) => current.worktreePath !== record.worktreePath,
        );
        batch(() => {
          self.managedWorktrees.set([...records, { ...record }]);
          for (const session of orderedSessions()) {
            if (session.workspacePath !== record.worktreePath) continue;
            session.update({
              ...session.entry.value,
              summary: {
                ...session.entry.value.summary,
                projectPath: record.projectPath,
                managedWorktree: record,
              },
            });
          }
          rebuildIndexes(orderedSessions());
          self.revision.update((revision) => revision + 1);
        });
      },
      applyResolvedState(sessionIds: readonly string[]) {
        const resolved = new Set(sessionIds);
        batch(() => {
          for (const session of orderedSessions()) {
            if (session.draft) continue;
            session.update({
              ...session.entry.value,
              summary: {
                ...session.entry.value.summary,
                resolved: resolved.has(session.sessionId),
              },
            });
          }
          self.revision.update((revision) => revision + 1);
        });
      },
      applyUnreadState(sessionIds: readonly string[]) {
        const unread = new Set(sessionIds);
        batch(() => {
          for (const session of orderedSessions())
            session.update({
              ...session.entry.value,
              summary: { ...session.entry.value.summary, unread: unread.has(session.sessionId) },
            });
          self.revision.update((revision) => revision + 1);
        });
      },
      setDraft(sessionId: string, draft: boolean) {
        updateEntry(sessionId, (entry) => ({ ...entry, draft }));
      },
      setResolved(sessionId: string, resolved: boolean) {
        updateEntry(
          sessionId,
          (entry) => ({
            ...entry,
            summary: { ...entry.summary, resolved },
          }),
          true,
        );
      },
      remove(sessionId: string) {
        const session = entryFor(sessionId);
        if (!session) return;
        const next = orderedSessions().filter((candidate) => candidate !== session);
        projection.replace(next);
        rebuildIndexes(next);
        self.revision.update((revision) => revision + 1);
      },
      rename(sessionId: string, title: string) {
        const session = entryFor(sessionId);
        if (!session) return undefined;
        const previous = session.title;
        updateEntry(sessionId, (entry) => ({
          ...entry,
          summary: { ...entry.summary, title },
        }));
        return previous;
      },
      updateWorkspaceNames(names: ReadonlyMap<string, string>) {
        batch(() => {
          for (const session of orderedSessions()) {
            const name = names.get(session.projectPath);
            if (!name || name === session.workspaceName) continue;
            session.update({
              ...session.entry.value,
              summary: { ...session.entry.value.summary, projectName: name },
            });
          }
          self.revision.update((revision) => revision + 1);
        });
      },
      awaitHydrated: Effect.fn("SessionCatalogStore.awaitHydrated")(function* () {
        if (!self.loading.value) return;
        yield* refStream(self.loading).pipe(
          Stream.filter((loading) => !loading),
          Stream.take(1),
          Stream.runDrain,
        );
      }),
    };
  },
);

export type SessionCatalogStoreInstance = StoreInstance<typeof SessionCatalogStoreFactory>;

export class SessionCatalogStore extends Context.Service<
  SessionCatalogStore,
  SessionCatalogStoreInstance
>()("cake/renderer/stores/SessionCatalogStore") {}
