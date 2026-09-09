import { Schema, type Stream } from "effect";
import { effect as reactiveEffect, type Model } from "r-state-tree";
import type {
  CakeChatCatalogQuery,
  CakeChatTarget,
  CakeChatUpdate,
} from "../../domain/cake-chats/cake-chat-data";
import type {
  CakeChatCatalogUpdate,
  DiscussionCatalogUpdate,
  ProjectCatalogUpdate,
  SessionCatalogUpdate,
} from "../../domain/application/catalog-data";
import type {
  DiscussionSessionTarget,
  DiscussionSessionUpdate,
} from "../../domain/discussion-sessions/discussion-session-data";
import type {
  ProjectSessionCatalogQuery,
  ProjectSessionTarget,
  ProjectSessionUpdate,
} from "../../domain/project-sessions/project-session-data";
import { ProjectSessionError } from "../../domain/project-sessions/project-session-data";
import type { SubagentUpdate } from "../../domain/subagents/subagent-data";
import type { ScheduledMessageUpdate } from "../../domain/scheduled-messages/scheduled-message-data";
import type { ManagedWorktreeCatalogUpdate } from "../../domain/worktrees/managed-worktree-data";
import type { WorktreeOperationCatalogUpdate } from "../../domain/worktrees/worktree-operation-data";
import type { CakeIpcClientService } from "../../ipc/client/CakeIpcClient";
import type { Runtime } from "../runtime";
import type { RootStore } from "../stores/RootStore";
import type { CakeChatCatalog } from "../models/CakeChatCatalog";
import type { ProjectCatalog } from "../models/ProjectCatalog";
import type { RootProjection } from "../models/RootProjection";
import type { Session } from "../models/Session";
import type { SessionCatalog } from "../models/SessionCatalog";
import type { WorktreeCatalog } from "../models/WorktreeCatalog";
import type { WorktreeOperationCatalog } from "../models/WorktreeOperationCatalog";
import {
  applyCakeChatCatalogGroupUpdate,
  applyProjectCatalogUpdate,
  applySessionCatalogGroupUpdate,
  CatalogIdentityCollisionError,
} from "../reducers/CatalogReducer";
import { applyCakeChatUpdate, applyProjectSessionUpdate } from "../reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate, applyDiscussionUpdate } from "../reducers/DiscussionReducer";
import { applySubagentUpdate } from "../reducers/SubagentReducer";
import { applyScheduledMessageUpdate } from "../reducers/ScheduledMessageReducer";
import { applyManagedWorktreeCatalogUpdate } from "../reducers/WorktreeCatalogReducer";
import { applyWorktreeOperationCatalogUpdate } from "../reducers/WorktreeOperationReducer";
import type { StreamFailureAction } from "./observe-stream";

type ObservedProjectSessionTarget = ProjectSessionTarget & { readonly workingDirectory: string };

interface ModelSource {
  readonly projection: RootProjection;
  readonly projectSessionCatalogQueries: () => ReadonlyArray<ProjectSessionCatalogQuery>;
  readonly cakeChatCatalogQueries?: () => ReadonlyArray<CakeChatCatalogQuery>;
  readonly loadedProjectSessions?: () => ReadonlyArray<ObservedProjectSessionTarget>;
  readonly loadedCakeChatIds?: () => ReadonlyArray<string>;
  readonly projectSessionTargets: () => ReadonlyArray<ObservedProjectSessionTarget>;
  readonly cakeChatTargets: () => ReadonlyArray<CakeChatTarget>;
}

type StreamFactory<Update> = (client: CakeIpcClientService) => Stream.Stream<Update, unknown>;

interface ModelObservation {
  readonly model: Model;
  readonly stop: () => void;
  readonly replacementGroup?: string;
  readonly clear?: () => void;
}

type ModelObservationOptions = Omit<ModelObservation, "model" | "stop">;

type ModelInput = {
  readonly projects: ProjectCatalog;
  readonly sessionCatalog: SessionCatalog;
  readonly worktrees?: WorktreeCatalog;
  readonly worktreeOperations?: WorktreeOperationCatalog;
  readonly projectSessionCatalogQueries?: ReadonlyArray<ProjectSessionCatalogQuery>;
  readonly cakeChatCatalog: CakeChatCatalog;
  readonly cakeChatCatalogQueries?: ReadonlyArray<CakeChatCatalogQuery>;
  readonly projectSessions: ReadonlyArray<{ target: ProjectSessionTarget; model: Session }>;
  readonly cakeChats: ReadonlyArray<{ target: CakeChatTarget; model: Session }>;
};

/** Creates the window's dynamic observer for passive projection Models. */
export const createModelObserver = (
  runtime: Runtime,
  onStopped?: (key: string, error: unknown, retry: () => void) => void,
) => {
  const observations = new Map<string, ModelObservation>();
  let stopObservingSource: (() => void) | undefined;
  let disposed = false;

  const unavailable = (key: string, error: unknown) =>
    key.startsWith("project-session:") &&
    Schema.is(ProjectSessionError)(error) &&
    error.operation === "observe" &&
    error.message === "That session is no longer available";

  const stop = (key: string, clear = true) => {
    const observation = observations.get(key);
    observation?.stop();
    observations.delete(key);
    if (clear) observation?.clear?.();
  };

  const observeModelStream = <Update>(
    key: string,
    model: Model,
    stream: StreamFactory<Update>,
    apply: (update: Update) => void,
    options: ModelObservationOptions,
  ) => {
    const current = observations.get(key);
    if (current?.model === model) return;
    if (current) stop(key);
    const cancel = runtime.observe(stream, apply, {
      onStopped: (error) => {
        if (unavailable(key, error)) return;
        onStopped?.(key, error, () => {
          if (disposed || observations.get(key)?.stop !== cancel) return;
          stop(key, false);
          observeModelStream(key, model, stream, apply, options);
        });
      },
      classifyFailure: (error): StreamFailureAction => (unavailable(key, error) ? "stop" : "retry"),
      reportFailure: (error) => {
        if (!unavailable(key, error))
          console.error(`[cake.renderer] ${key} observation failed`, error);
      },
    });
    observations.set(key, { model, stop: cancel, ...options });
  };

  const assertSessionIdentity = (model: Session, sessionId: string, workingDirectory?: string) => {
    if (model.sessionId !== sessionId)
      throw new Error(`Session Model identity collision: ${sessionId}`);
    if (
      model.sessionFile &&
      workingDirectory &&
      model.workingDirectory &&
      model.workingDirectory !== workingDirectory
    )
      throw new Error(`Session Model Working Directory collision: ${sessionId}`);
  };

  const sync = (input: ModelInput) => {
    const active = new Set<string>();
    const observe = <Update>(
      key: string,
      model: Model,
      stream: StreamFactory<Update>,
      apply: (update: Update) => void,
      options: ModelObservationOptions = {},
    ) => {
      active.add(key);
      observeModelStream(key, model, stream, apply, options);
    };

    const worktreeOperations = input.worktreeOperations;
    if (worktreeOperations)
      observe(
        "managed-worktree-operations",
        worktreeOperations,
        (client) => client.managedWorktrees.observeOperations(),
        (update: WorktreeOperationCatalogUpdate) =>
          applyWorktreeOperationCatalogUpdate(worktreeOperations, update),
      );
    const worktrees = input.worktrees;
    if (worktrees)
      observe(
        "managed-worktrees",
        worktrees,
        (client) => client.managedWorktrees.observeCatalog(),
        (update: ManagedWorktreeCatalogUpdate) =>
          applyManagedWorktreeCatalogUpdate(worktrees, update),
      );
    observe(
      "projects",
      input.projects,
      (client) => client.projects.observeCatalog(),
      (update: ProjectCatalogUpdate) => applyProjectCatalogUpdate(input.projects, update),
    );
    for (const query of input.projectSessionCatalogQueries ?? []) {
      const key = `project-session-catalog:${query.resolved ? "resolved" : "active"}:${query.projectPath}`;
      observe(
        key,
        input.sessionCatalog,
        (client) => client.projectSessions.observeCatalog(query),
        (update: SessionCatalogUpdate) =>
          applySessionCatalogGroupUpdate(input.sessionCatalog, query, update),
        {
          replacementGroup: key,
          clear: () =>
            applySessionCatalogGroupUpdate(input.sessionCatalog, query, {
              _tag: "Snapshot",
              revision: 0,
              sessions: [],
            }),
        },
      );
    }

    for (const query of input.cakeChatCatalogQueries ?? [{ resolved: false }]) {
      const key = `cake-chat-catalog:${query.resolved ? `resolved:${query.limit}` : "active"}`;
      observe(
        key,
        input.cakeChatCatalog,
        (client) => client.cakeChats.observeCatalog(query),
        (update: CakeChatCatalogUpdate) =>
          applyCakeChatCatalogGroupUpdate(input.cakeChatCatalog, query, update),
        {
          replacementGroup: `cake-chat-catalog:${query.resolved ? "resolved" : "active"}`,
          clear: () =>
            applyCakeChatCatalogGroupUpdate(input.cakeChatCatalog, query, {
              _tag: "Snapshot",
              revision: 0,
              sessions: [],
            }),
        },
      );
    }

    for (const { target, model } of input.projectSessions) {
      assertSessionIdentity(model, target.sessionId, target.workingDirectory);
      observe(
        `project-session:${target.sessionId}`,
        model,
        (client) => client.projectSessions.observe(target),
        (update: ProjectSessionUpdate) =>
          applyProjectSessionUpdate(model, target.sessionId, update),
      );
      observe(
        `scheduled-messages:${target.sessionId}`,
        model,
        (client) => client.scheduledMessages.observe(target.sessionId),
        (update: ScheduledMessageUpdate) => applyScheduledMessageUpdate(model, update),
      );
      observe(
        `discussion-catalog:${target.sessionId}`,
        model,
        (client) =>
          client.discussionSessions.observeCatalog({
            parentSessionId: target.sessionId,
            workingDirectory: target.workingDirectory ?? model.workingDirectory,
          }),
        (update: DiscussionCatalogUpdate) =>
          applyDiscussionCatalogUpdate(model, target.sessionId, update),
      );
      observe(
        `subagents:${target.sessionId}`,
        model,
        (client) => client.subagents.observe(target.sessionId),
        (update: SubagentUpdate) => applySubagentUpdate(model, target.sessionId, update),
      );

      for (const thread of model.reviewThreads) {
        if (!thread.sidecarSessionId) continue;
        const target: DiscussionSessionTarget = {
          parentSessionId: thread.parentSessionId,
          workingDirectory: thread.workingDirectory,
          threadId: thread.id,
        };
        observe(
          `discussion:${thread.id}`,
          thread,
          (client) => client.discussionSessions.observe(target),
          (update: DiscussionSessionUpdate) => applyDiscussionUpdate(thread, thread.id, update),
        );
      }
    }

    for (const { target, model } of input.cakeChats) {
      assertSessionIdentity(model, target.sessionId);
      observe(
        `cake-chat:${target.sessionId}`,
        model,
        (client) => client.cakeChats.observe(target),
        (update: CakeChatUpdate) => applyCakeChatUpdate(model, target.sessionId, update),
      );
    }

    for (const [key, observation] of observations) {
      if (active.has(key)) continue;
      const hasReplacement =
        observation.replacementGroup !== undefined &&
        [...observations.entries()].some(
          ([candidateKey, candidate]) =>
            active.has(candidateKey) &&
            candidate.model === observation.model &&
            candidate.replacementGroup === observation.replacementGroup,
        );
      stop(key, !hasReplacement);
    }
  };

  const observe = (source: ModelSource) => {
    if (stopObservingSource)
      throw new Error("Renderer Model observation already has a Model source");
    stopObservingSource = reactiveEffect(() => {
      const loadedProjectSessions = source.loadedProjectSessions?.();
      if (loadedProjectSessions) {
        const loadedIds = new Set(loadedProjectSessions.map(({ sessionId }) => sessionId));
        for (const target of loadedProjectSessions)
          source.projection.projectSession(target.sessionId, target.workingDirectory);
        for (const sessionId of source.projection.projectSessions.map(({ sessionId }) => sessionId))
          if (!loadedIds.has(sessionId)) source.projection.removeProjectSession(sessionId);
      }
      const loadedCakeChatIds = source.loadedCakeChatIds?.();
      if (loadedCakeChatIds) {
        const loadedIds = new Set(loadedCakeChatIds);
        for (const sessionId of loadedCakeChatIds) source.projection.cakeChat(sessionId);
        for (const sessionId of source.projection.cakeChats.map(({ sessionId }) => sessionId))
          if (!loadedIds.has(sessionId)) source.projection.removeCakeChat(sessionId);
      }
      sync({
        projects: source.projection.projects,
        sessionCatalog: source.projection.sessionCatalog,
        worktrees: source.projection.worktrees,
        worktreeOperations: source.projection.worktreeOperations,
        projectSessionCatalogQueries: source.projectSessionCatalogQueries(),
        cakeChatCatalog: source.projection.cakeChatCatalog,
        cakeChatCatalogQueries: source.cakeChatCatalogQueries?.(),
        projectSessions: source.projectSessionTargets().map((target) => ({
          target,
          model: source.projection.projectSession(target.sessionId, target.workingDirectory),
        })),
        cakeChats: source.cakeChatTargets().map((target) => ({
          target,
          model: source.projection.cakeChat(target.sessionId),
        })),
      });
    });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopObservingSource?.();
    stopObservingSource = undefined;
    for (const observation of observations.values()) observation.stop();
    observations.clear();
  };

  return { observe, sync, stop: dispose };
};

export const observationFailureDetails = (key: string, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const collisionIds =
    error instanceof CatalogIdentityCollisionError
      ? error.values
      : (message
          .match(/Session ID collision: ([^(\n]+)/)?.[1]
          ?.split(",")
          .map((value) => value.trim())
          .filter(Boolean) ?? []);
  const context =
    error instanceof CatalogIdentityCollisionError && error.context
      ? [`Context: ${error.context}`]
      : [];
  const stack = error instanceof Error && error.stack ? error.stack : undefined;
  return [
    `Observer: ${key}`,
    `Error: ${message}`,
    ...(collisionIds.length > 0 ? [`Session IDs: ${collisionIds.join(", ")}`] : []),
    ...context,
    ...(stack && stack !== message ? ["", "Stack / cause:", stack] : []),
  ].join("\n");
};

/** Observes the Models demanded by one renderer window's Store tree. */
export const observeModels = (runtime: Runtime, projection: RootProjection, root: RootStore) => {
  const observer = createModelObserver(runtime, (key, error, retry) => {
    root.toastStore.show({
      tone: "error",
      title: "Updates stopped",
      autoDismiss: false,
      message: "Updates for this view stopped. Retry to reconnect.",
      details: observationFailureDetails(key, error),
      coalesceKey: `observation:${key}`,
      action: { label: "Retry", run: retry },
    });
  });
  observer.observe({
    projection,
    projectSessionCatalogQueries: () => root.projectSessionCatalogQueries,
    cakeChatCatalogQueries: () => root.sidebarStore.cakeChatCatalogQueries,
    loadedProjectSessions: () =>
      root.sessionRegistry.targets.map(({ sessionId, workspacePath }) => ({
        sessionId,
        workingDirectory: workspacePath,
      })),
    loadedCakeChatIds: () => root.cakeChatCollectionStore.registry.targets,
    projectSessionTargets: () => root.projectSessionObservationTargets,
    cakeChatTargets: () => root.cakeChatCollectionStore.registry.observationTargets,
  });
  return observer.stop;
};
