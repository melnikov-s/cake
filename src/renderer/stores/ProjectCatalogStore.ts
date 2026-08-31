import { Context, Effect, Schema, Stream } from "effect";
import { Model, Store, batch, createStore, refStream, type StoreInstance } from "effect-state-tree";
import { ProjectRecord } from "../../domain/application-data";
import type { ApplicationState } from "../../ipc/session-contract";
import type { ProjectCatalogUpdate } from "../../domain/catalog-data";
import { CakeIpcClient } from "../../ipc/client/CakeIpcClient";
import { describeError } from "../error-details";
import { Project, type Project as ProjectInstance } from "../models/Project";
import { ProjectCollection } from "../models/ProjectCollection";
import type { SessionCatalogStoreInstance } from "./SessionCatalogStore";

/** Window-lifetime registered Project projection, selection order, and scoped RPC subscription. */
export const ProjectCatalogStoreFactory = createStore(
  "ProjectCatalogStore",
  Store.schema({
    props: { sessions: Store.prop<SessionCatalogStoreInstance>() },
    recentPaths: Schema.Array(ProjectRecord.fields.path),
    loading: Schema.Boolean,
    revision: Schema.Int,
    sourceRevision: Schema.Int,
    error: Schema.optional(Schema.String),
    errorDetails: Schema.optional(Schema.String),
  }),
  function* ({ self, props: { sessions }, autorun }) {
    const client = yield* CakeIpcClient;
    const projection = yield* ProjectCollection.make({ projects: [] }).pipe(Effect.orDie);
    yield* Effect.addFinalizer(() => Effect.sync(() => projection[Symbol.dispose]()));
    let indexed = new Map<string, ProjectInstance>();
    const orderedProjects = () =>
      projection.projects.value.flatMap((project) => {
        const found = indexed.get(project.identity.value);
        return found ? [found] : [];
      });

    const reconcileRecentPaths = () => {
      const registered = new Set(orderedProjects().map((project) => project.path));
      const paths = self.recentPaths.value.filter((path) => registered.has(path));
      for (const project of orderedProjects())
        if (!paths.includes(project.path)) paths.push(project.path);
      self.recentPaths.set(paths);
    };

    const reconcile = Effect.fn("ProjectCatalogStore.reconcile")(function* (
      records: ReadonlyArray<ProjectRecord>,
      sourceRevision?: number,
    ) {
      const seen = new Set<string>();
      for (const record of records) {
        if (seen.has(record.path))
          return yield* Effect.fail(new Model.IdentityCollisionError(Project.schema, record.path));
        seen.add(record.path);
      }
      const current = indexed;
      const next: ProjectInstance[] = [];
      const updates: Array<readonly [ProjectInstance, ProjectRecord]> = [];
      for (const record of records) {
        const existing = current.get(record.path);
        if (existing) {
          next.push(existing);
          updates.push([existing, record]);
        } else {
          next.push(yield* Project.make({ identity: record.path, record }));
        }
      }
      batch(() => {
        for (const [project, record] of updates) project.update(record);
        projection.replace(next);
        indexed = new Map(next.map((project) => [project.path, project]));
        reconcileRecentPaths();
        sessions.value.updateWorkspaceNames(
          new Map(records.map((project) => [project.path, project.name])),
        );
        if (sourceRevision !== undefined) self.sourceRevision.set(sourceRevision);
        self.revision.update((revision) => revision + 1);
      });
    });

    const reduce = Effect.fn("ProjectCatalogStore.reduce")(function* (
      update: ProjectCatalogUpdate,
    ) {
      if (update._tag === "Snapshot") {
        yield* reconcile(update.projects, update.revision);
        return;
      }
      if (update.revision <= self.sourceRevision.value) return;
      const event = update.event;
      switch (event._tag) {
        case "Replaced":
          yield* reconcile(event.projects, update.revision);
          return;
        case "Upserted":
          yield* reconcile(
            [
              ...orderedProjects()
                .filter((project) => project.path !== event.project.path)
                .map((project) => project.record.value),
              event.project,
            ],
            update.revision,
          );
          return;
        case "Removed":
          if (!orderedProjects().some((project) => project.path === event.path)) {
            self.sourceRevision.set(update.revision);
            return;
          }
          yield* reconcile(
            orderedProjects()
              .filter((project) => project.path !== event.path)
              .map((project) => project.record.value),
            update.revision,
          );
      }
    });

    const setError = (error: unknown) => {
      const described = describeError(error, "Project catalog");
      batch(() => {
        self.error.set(described.message);
        self.errorDetails.set(described.details);
        self.loading.set(false);
      });
    };

    autorun(
      "observeCatalog",
      client.projects.observeCatalog().pipe(
        Stream.runForEach((update) =>
          reduce(update).pipe(Effect.tap(() => Effect.sync(() => self.loading.set(false)))),
        ),
        Effect.catch((error) => Effect.sync(() => setError(error))),
      ),
    );

    const find = (path: string) => indexed.get(path);
    const nameFromPath = (path: string) => {
      const normalized = path.replace(/\/+$/, "");
      return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
    };

    return {
      get projects(): ReadonlyArray<ProjectInstance> {
        return orderedProjects();
      },
      get recentProjectPaths(): ReadonlyArray<string> {
        return self.recentPaths.value;
      },
      find(path: string) {
        void self.revision.value;
        return find(path);
      },
      nameFromPath,
      nameForPath(path: string) {
        const registeredPath = sessions.value.projectOfManagedWorktree(path) ?? path;
        return find(registeredPath)?.name ?? nameFromPath(registeredPath);
      },
      get orderedProjectPaths() {
        const persistedOrder = new Map(self.recentPaths.value.map((path, index) => [path, index]));
        const lastSessionByProject = new Map<string, string>();
        for (const session of sessions.value.sessions) {
          const previous = lastSessionByProject.get(session.projectPath);
          if (!previous || session.modified > previous)
            lastSessionByProject.set(session.projectPath, session.modified);
        }
        return [...self.recentPaths.value].sort((left, right) => {
          const leftLastSession = lastSessionByProject.get(left);
          const rightLastSession = lastSessionByProject.get(right);
          if (leftLastSession && rightLastSession && leftLastSession !== rightLastSession)
            return rightLastSession.localeCompare(leftLastSession);
          if (leftLastSession) return -1;
          if (rightLastSession) return 1;
          const leftLastOpened = find(left)?.lastOpenedAt ?? "";
          const rightLastOpened = find(right)?.lastOpenedAt ?? "";
          if (leftLastOpened !== rightLastOpened)
            return rightLastOpened.localeCompare(leftLastOpened);
          return (persistedOrder.get(left) ?? 0) - (persistedOrder.get(right) ?? 0);
        });
      },
      replace: Effect.fn("ProjectCatalogStore.replace")((records: ReadonlyArray<ProjectRecord>) =>
        reconcile(records),
      ),
      applyApplicationState: Effect.fn("ProjectCatalogStore.applyApplicationState")(function* (
        state: ApplicationState,
      ) {
        sessions.value.applyResolvedState(state.resolvedSessionIds);
        sessions.value.applyUnreadState(state.unreadSessionIds);
        yield* reconcile(state.projects);
      }),
      restoreRecentPaths(paths: readonly string[]) {
        self.recentPaths.set([...paths]);
        reconcileRecentPaths();
      },
      recordOpened(path: string) {
        if (!self.recentPaths.value.includes(path))
          self.recentPaths.update((paths) => [...paths, path]);
      },
      awaitHydrated: Effect.fn("ProjectCatalogStore.awaitHydrated")(function* () {
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

export type ProjectCatalogStoreInstance = StoreInstance<typeof ProjectCatalogStoreFactory>;

export class ProjectCatalogStore extends Context.Service<
  ProjectCatalogStore,
  ProjectCatalogStoreInstance
>()("cake/renderer/stores/ProjectCatalogStore") {}
