import { Effect, Schema, Stream } from "effect";
import { effect as reactiveEffect, type Model } from "r-state-tree";
import type {
  CakeChatCatalogQuery,
  CakeChatTarget,
  CakeChatUpdate,
} from "../domain/cake-chat-data";
import type {
  CakeChatCatalogUpdate,
  DiscussionCatalogUpdate,
  ProjectCatalogUpdate,
  SessionCatalogUpdate,
} from "../domain/catalog-data";
import type {
  DiscussionSessionTarget,
  DiscussionSessionUpdate,
} from "../domain/discussion-session-data";
import type {
  ProjectSessionCatalogQuery,
  ProjectSessionTarget,
  ProjectSessionUpdate,
} from "../domain/project-session-data";
import { ProjectSessionError } from "../domain/project-session-data";
import type { SubagentUpdate } from "../domain/subagent-data";
import type { ScheduledMessageUpdate } from "../domain/scheduled-message-data";
import { CakeIpcClient, type CakeIpcClientService } from "../ipc/client/CakeIpcClient";
import type { ArtifactRecord } from "../ipc/artifact-contract";
import type { CakeChatCatalog } from "./models/CakeChatCatalog";
import type { ProjectCatalog } from "./models/ProjectCatalog";
import type { Session } from "./models/Session";
import type { SessionCatalog } from "./models/SessionCatalog";
import type { RendererRuntime } from "./RendererRuntime";
import {
  applyCakeChatCatalogGroupUpdate,
  applyProjectCatalogUpdate,
  applySessionCatalogGroupUpdate,
} from "./projections/CatalogProjection";
import { applyArtifactUpdate } from "./projections/ArtifactProjection";
import {
  applyCakeChatUpdate,
  applyProjectSessionUpdate,
} from "./projections/ConversationProjection";
import {
  applyDiscussionCatalogUpdate,
  applyDiscussionUpdate,
} from "./projections/DiscussionProjection";
import { applySubagentUpdate } from "./projections/SubagentProjection";
import { applyScheduledMessageUpdate } from "./projections/ScheduledMessageProjection";
import type {
  RendererSynchronizationSupervisor,
  SynchronizationFailureAction,
} from "./RendererSynchronizationSupervisor";

export interface RendererModelSource {
  readonly projects: ProjectCatalog;
  readonly sessionCatalog: SessionCatalog;
  readonly projectSessionCatalogQueries: () => ReadonlyArray<ProjectSessionCatalogQuery>;
  readonly cakeChatCatalog: CakeChatCatalog;
  readonly cakeChatCatalogQueries?: () => ReadonlyArray<CakeChatCatalogQuery>;
  readonly projectSessions: () => ReadonlyArray<{
    readonly target: ProjectSessionTarget;
    readonly model: Session;
  }>;
  readonly cakeChats: () => ReadonlyArray<{
    readonly target: CakeChatTarget;
    readonly model: Session;
  }>;
}

interface RevisionedUpdate {
  readonly _tag: string;
  readonly revision: number;
}

interface Subscription {
  generation: number;
  revision: number | undefined;
}

class RevisionGapError extends Error {}

type StreamFactory<Update> = (client: CakeIpcClientService) => Stream.Stream<Update, unknown>;

/**
 * The renderer's one Stream-to-Model boundary. It listens to authoritative RPC
 * Streams and synchronizes passive r-state-tree Models. Authoritative snapshots
 * hydrate Models; incremental Events use direct reactive batches. Stores and
 * Models never see Effect, RPC, revisions, or Fibers.
 */
export class RendererModelSynchronizer implements Disposable {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly models = new Map<string, Model>();
  private readonly catalogGroups = new Map<
    string,
    { readonly model: SessionCatalog; readonly query: ProjectSessionCatalogQuery }
  >();
  private readonly cakeChatCatalogGroups = new Map<
    string,
    { readonly model: CakeChatCatalog; readonly query: CakeChatCatalogQuery }
  >();
  private stopObservingSource: (() => void) | undefined;
  private disposed = false;

  constructor(
    private readonly runtime: RendererRuntime,
    private readonly supervisor: RendererSynchronizationSupervisor,
  ) {}

  /** Watches loaded Models from renderer infrastructure, outside the Store tree. */
  observe(source: RendererModelSource) {
    if (this.stopObservingSource)
      throw new Error("Renderer Model synchronization already has a Model source");
    this.stopObservingSource = reactiveEffect(() => {
      this.sync({
        projects: source.projects,
        sessionCatalog: source.sessionCatalog,
        projectSessionCatalogQueries: source.projectSessionCatalogQueries(),
        cakeChatCatalog: source.cakeChatCatalog,
        cakeChatCatalogQueries: source.cakeChatCatalogQueries?.(),
        projectSessions: source.projectSessions(),
        cakeChats: source.cakeChats(),
      });
    });
  }

  /** Applies native artifact persistence notifications through the same Model boundary. */
  updateArtifact(record: ArtifactRecord) {
    const model = this.models.get(`project-session:${record.artifact.sessionId}`);
    if (!model) return;
    // SAFETY: project-session subscription keys are registered exclusively with Session Models.
    applyArtifactUpdate(model as Session, record);
  }

  sync(input: {
    readonly projects: ProjectCatalog;
    readonly sessionCatalog: SessionCatalog;
    readonly projectSessionCatalogQueries?: ReadonlyArray<ProjectSessionCatalogQuery>;
    readonly cakeChatCatalog: CakeChatCatalog;
    readonly cakeChatCatalogQueries?: ReadonlyArray<CakeChatCatalogQuery>;
    readonly projectSessions: ReadonlyArray<{ target: ProjectSessionTarget; model: Session }>;
    readonly cakeChats: ReadonlyArray<{ target: CakeChatTarget; model: Session }>;
  }) {
    const active = new Set(["projects"]);
    this.synchronizeModel(
      "projects",
      input.projects,
      (client) => client.projects.observeCatalog(),
      (update: ProjectCatalogUpdate) => applyProjectCatalogUpdate(input.projects, update),
    );
    for (const query of input.projectSessionCatalogQueries ?? []) {
      const key = `project-session-catalog:${query.resolved ? "resolved" : "active"}:${query.projectPath}`;
      active.add(key);
      this.catalogGroups.set(key, { model: input.sessionCatalog, query });
      this.synchronizeModel(
        key,
        input.sessionCatalog,
        (client) => client.projectSessions.observeCatalog(query),
        (update: SessionCatalogUpdate) =>
          applySessionCatalogGroupUpdate(input.sessionCatalog, query, update),
      );
    }

    for (const query of input.cakeChatCatalogQueries ?? [{ resolved: false }]) {
      const key = `cake-chat-catalog:${query.resolved ? "resolved" : "active"}`;
      active.add(key);
      this.cakeChatCatalogGroups.set(key, { model: input.cakeChatCatalog, query });
      this.synchronizeModel(
        key,
        input.cakeChatCatalog,
        (client) => client.cakeChats.observeCatalog(query),
        (update: CakeChatCatalogUpdate) =>
          applyCakeChatCatalogGroupUpdate(input.cakeChatCatalog, query, update),
      );
    }

    for (const { target, model } of input.projectSessions) {
      this.assertSessionIdentity(model, target.sessionId, target.workingDirectory);
      const sessionKey = `project-session:${target.sessionId}`;
      active.add(sessionKey);
      this.synchronizeModel(
        sessionKey,
        model,
        (client) => client.projectSessions.observe(target),
        (update: ProjectSessionUpdate) =>
          applyProjectSessionUpdate(model, target.sessionId, update),
      );

      const scheduledMessagesKey = `scheduled-messages:${target.sessionId}`;
      active.add(scheduledMessagesKey);
      this.synchronizeModel(
        scheduledMessagesKey,
        model,
        (client) => client.scheduledMessages.observe(target.sessionId),
        (update: ScheduledMessageUpdate) => applyScheduledMessageUpdate(model, update),
      );

      const discussionCatalogKey = `discussion-catalog:${target.sessionId}`;
      active.add(discussionCatalogKey);
      this.synchronizeModel(
        discussionCatalogKey,
        model,
        (client) =>
          client.discussionSessions.observeCatalog({
            parentSessionId: target.sessionId,
            workingDirectory: target.workingDirectory ?? model.workingDirectory,
          }),
        (update: DiscussionCatalogUpdate) =>
          applyDiscussionCatalogUpdate(model, target.sessionId, update),
      );

      const subagentKey = `subagents:${target.sessionId}`;
      active.add(subagentKey);
      this.synchronizeModel(
        subagentKey,
        model,
        (client) => client.subagents.observe(target.sessionId),
        (update: SubagentUpdate) => applySubagentUpdate(model, target.sessionId, update),
      );

      for (const thread of model.reviewThreads) {
        if (!thread.sidecarSessionId) continue;
        const key = `discussion:${thread.id}`;
        active.add(key);
        const discussionTarget: DiscussionSessionTarget = {
          parentSessionId: thread.parentSessionId,
          workingDirectory: thread.workingDirectory,
          threadId: thread.id,
        };
        this.synchronizeModel(
          key,
          thread,
          (client) => client.discussionSessions.observe(discussionTarget),
          (update: DiscussionSessionUpdate) => applyDiscussionUpdate(thread, thread.id, update),
        );
      }
    }

    for (const { target, model } of input.cakeChats) {
      this.assertSessionIdentity(model, target.sessionId);
      const key = `cake-chat:${target.sessionId}`;
      active.add(key);
      this.synchronizeModel(
        key,
        model,
        (client) => client.cakeChats.observe(target),
        (update: CakeChatUpdate) => applyCakeChatUpdate(model, target.sessionId, update),
      );
    }

    for (const key of this.subscriptions.keys()) if (!active.has(key)) this.stop(key);
  }

  [Symbol.dispose]() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopObservingSource?.();
    this.stopObservingSource = undefined;
    for (const key of this.subscriptions.keys()) this.supervisor.unregister(`model:${key}`);
    this.subscriptions.clear();
    this.models.clear();
    this.catalogGroups.clear();
    this.cakeChatCatalogGroups.clear();
  }

  private synchronizeModel<Update extends RevisionedUpdate>(
    key: string,
    model: Model,
    stream: StreamFactory<Update>,
    apply: (update: Update) => void,
  ) {
    const current = this.models.get(key);
    if (current === model) return;
    if (current) this.stop(key);
    this.models.set(key, model);
    this.synchronize(key, stream, apply);
  }

  private synchronize<Update extends RevisionedUpdate>(
    key: string,
    stream: StreamFactory<Update>,
    apply: (update: Update) => void,
  ) {
    if (this.disposed || this.subscriptions.has(key)) return;
    const subscription: Subscription = { generation: 0, revision: undefined };
    this.subscriptions.set(key, subscription);
    this.supervisor.register(`model:${key}`, {
      run: (signal, markHealthy) => {
        subscription.generation += 1;
        subscription.revision = undefined;
        const generation = subscription.generation;
        const consume = Effect.flatMap(CakeIpcClient, (client) =>
          stream(client).pipe(
            Stream.runForEach((update) =>
              Effect.sync(() => {
                const decision = this.accept(subscription, generation, update);
                if (decision === "restart") throw new RevisionGapError();
                if (decision === "apply") {
                  markHealthy();
                  apply(update);
                }
              }),
            ),
          ),
        );
        return this.runtime.execute(consume, signal);
      },
      classifyFailure: (error) => this.classifyFailure(key, error),
      reportFailure: (error) => this.reportFailure(key, error),
    });
  }

  private stop(key: string) {
    this.supervisor.unregister(`model:${key}`);
    this.subscriptions.delete(key);
    this.models.delete(key);
    const catalog = this.catalogGroups.get(key);
    if (catalog) {
      applySessionCatalogGroupUpdate(catalog.model, catalog.query, {
        _tag: "Snapshot",
        revision: 0,
        sessions: [],
      });
      this.catalogGroups.delete(key);
    }
    const cakeChatCatalog = this.cakeChatCatalogGroups.get(key);
    if (cakeChatCatalog) {
      applyCakeChatCatalogGroupUpdate(cakeChatCatalog.model, cakeChatCatalog.query, {
        _tag: "Snapshot",
        revision: 0,
        sessions: [],
      });
      this.cakeChatCatalogGroups.delete(key);
    }
  }

  private classifyFailure(key: string, error: unknown): SynchronizationFailureAction {
    return isUnavailableProjectSessionObservation(key, error) ? "stop" : "retry";
  }

  private reportFailure(key: string, error: unknown) {
    if (error instanceof RevisionGapError || isUnavailableProjectSessionObservation(key, error))
      return;
    console.error(`[cake.renderer] ${key} synchronization failed`, error);
  }

  private accept(subscription: Subscription, generation: number, update: RevisionedUpdate) {
    if (generation !== subscription.generation) return "ignore" as const;
    if (subscription.revision === undefined) {
      if (update._tag !== "Snapshot") return "ignore" as const;
    } else {
      if (update.revision <= subscription.revision) return "ignore" as const;
      if (update._tag === "Snapshot" || update.revision !== subscription.revision + 1)
        return "restart" as const;
    }
    subscription.revision = update.revision;
    return "apply" as const;
  }

  private assertSessionIdentity(model: Session, sessionId: string, workingDirectory?: string) {
    if (model.sessionId !== sessionId)
      throw new Error(`Session Model identity collision: ${sessionId}`);
    // A renderer-only composer has an identity placeholder but no authoritative Pi snapshot yet.
    // Its Working Directory may change before `projectSessions.start` materializes the session.
    if (
      model.sessionFile &&
      workingDirectory &&
      model.workingDirectory &&
      model.workingDirectory !== workingDirectory
    )
      throw new Error(`Session Model Working Directory collision: ${sessionId}`);
  }
}

const isUnavailableProjectSessionObservation = (key: string, error: unknown) =>
  key.startsWith("project-session:") &&
  Schema.is(ProjectSessionError)(error) &&
  error.operation === "observe" &&
  error.message === "That session is no longer available";
