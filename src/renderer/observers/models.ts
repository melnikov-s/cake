import { Schema, type Stream } from "effect";
import { effect as reactiveEffect, type Model } from "r-state-tree";
import type {
  CakeChatCatalogQuery,
  CakeChatTarget,
  CakeChatControlUpdate,
} from "../../domain/cake-chats/cake-chat-data";
import type {
  CakeChatCatalogUpdate,
  DiscussionCatalogUpdate,
  ProjectCatalogUpdate,
  SessionCatalogUpdate,
} from "../../domain/application/catalog-data";
import { SessionChatError } from "../../domain/conversations/conversation-data";
import type {
  DiscussionSessionTarget,
  DiscussionSessionUpdate,
} from "../../domain/discussion-sessions/discussion-session-data";
import {
  hasSidecarConversation,
  isSessionAssistantThread,
} from "../../domain/discussion-sessions/discussion-session-data";
import type { CakeControlTool } from "../../domain/cake-chats/cake-chat-data";
import type { ReviewThread } from "../models/ReviewThread";
import type {
  ProjectSessionCatalogQuery,
  ProjectSessionTarget,
} from "../../domain/project-sessions/project-session-data";
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
import type { Conversation } from "../models/Conversation";
import type { DiscussionCatalog } from "../models/DiscussionCatalog";
import type { SubagentCatalog } from "../models/SubagentCatalog";
import type { ScheduledMessageCatalog } from "../models/ScheduledMessageCatalog";
import type { CakeChatControls } from "../models/CakeChatControls";
import type { SessionCatalog } from "../models/SessionCatalog";
import type { WorktreeCatalog } from "../models/WorktreeCatalog";
import type { WorktreeOperationCatalog } from "../models/WorktreeOperationCatalog";
import {
  applyCakeChatCatalogGroupUpdate,
  applyProjectCatalogUpdate,
  applySessionCatalogGroupUpdate,
  CatalogIdentityCollisionError,
} from "../reducers/CatalogReducer";
import {
  applyConversationUpdate,
  applyDiscussionSessionUpdate,
  unloadConversationProjection,
} from "../reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate } from "../reducers/DiscussionReducer";
import { applyCakeChatControlUpdate } from "../reducers/CakeChatControlReducer";
import { applySubagentUpdate } from "../reducers/SubagentReducer";
import { applyScheduledMessageUpdate } from "../reducers/ScheduledMessageReducer";
import { applyManagedWorktreeCatalogUpdate } from "../reducers/WorktreeCatalogReducer";
import { applyWorktreeOperationCatalogUpdate } from "../reducers/WorktreeOperationReducer";
import type { StreamFailureAction } from "./observe-stream";

type ObservedProjectSessionTarget = ProjectSessionTarget & { readonly workingDirectory: string };

interface ModelSource {
  readonly projection: RootProjection;
  readonly projectSessionCatalogQueries: () => ReadonlyArray<ProjectSessionCatalogQuery>;
  readonly onProjectSessionTitleChanged?: (sessionId: string, title: string) => void;
  readonly cakeChatCatalogQueries?: () => ReadonlyArray<CakeChatCatalogQuery>;
  readonly loadedProjectSessions?: () => ReadonlyArray<ObservedProjectSessionTarget>;
  readonly loadedCakeChatIds?: () => ReadonlyArray<string>;
  readonly projectSessionTargets: () => ReadonlyArray<ObservedProjectSessionTarget>;
  /**
   * Staged Project Sessions have no Pi session to observe yet, but their
   * Discussion catalog is observed so an assistant thread can exist first.
   */
  readonly stagedProjectSessionTargets?: () => ReadonlyArray<ObservedProjectSessionTarget>;
  readonly cakeChatTargets: () => ReadonlyArray<CakeChatTarget>;
  /** The Cake control catalog a session assistant sidecar is acquired with. */
  readonly sessionAssistantTools?: () => ReadonlyArray<CakeControlTool>;
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
  readonly onProjectSessionTitleChanged?: (sessionId: string, title: string) => void;
  readonly cakeChatCatalog: CakeChatCatalog;
  readonly cakeChatCatalogQueries?: ReadonlyArray<CakeChatCatalogQuery>;
  readonly projectSessions: ReadonlyArray<{
    target: ProjectSessionTarget;
    conversation: Conversation;
    discussions: DiscussionCatalog;
    subagents: SubagentCatalog;
    schedules: ScheduledMessageCatalog;
  }>;
  /** Staged parents observed for their Discussion catalog only. */
  readonly discussionCatalogs?: ReadonlyArray<{
    target: ProjectSessionTarget;
    model: DiscussionCatalog;
  }>;
  readonly cakeChats: ReadonlyArray<{
    target: CakeChatTarget;
    conversation: Conversation;
    controls: CakeChatControls;
  }>;
  readonly discussionSessions?: ReadonlyArray<{
    thread: ReviewThread;
    model: Conversation;
    tools?: ReadonlyArray<CakeControlTool>;
  }>;
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
    key.startsWith("conversation:") &&
    Schema.is(SessionChatError)(error) &&
    error.operation === "observeProjectSession" &&
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

  const assertSessionIdentity = (model: Conversation, sessionId: string) => {
    if (model.sessionId !== sessionId)
      throw new Error(`Conversation Model identity collision: ${sessionId}`);
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

    const observeDiscussionCatalog = (target: ProjectSessionTarget, model: DiscussionCatalog) =>
      observe(
        `discussion-catalog:${target.sessionId}`,
        model,
        (client) =>
          client.discussionSessions.observeCatalog({
            parentSessionId: target.sessionId,
            workingDirectory: target.workingDirectory ?? "",
          }),
        (update: DiscussionCatalogUpdate) =>
          applyDiscussionCatalogUpdate(model, target.sessionId, update),
      );

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
        (update: SessionCatalogUpdate) => {
          applySessionCatalogGroupUpdate(input.sessionCatalog, query, update);
          if (update._tag === "Event" && update.event._tag === "TitleChanged" && !query.resolved)
            input.onProjectSessionTitleChanged?.(update.event.sessionId, update.event.title);
        },
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

    for (const {
      target,
      conversation,
      discussions,
      subagents,
      schedules,
    } of input.projectSessions) {
      assertSessionIdentity(conversation, target.sessionId);
      observe(
        `conversation:${target.sessionId}`,
        conversation,
        (client) => client.conversations.observe({ _tag: "ProjectSession", ...target }),
        (update) => applyConversationUpdate(conversation, update),
        { clear: () => unloadConversationProjection(conversation) },
      );
      observe(
        `scheduled-messages:${target.sessionId}`,
        schedules,
        (client) => client.scheduledMessages.observe(target.sessionId),
        (update: ScheduledMessageUpdate) => applyScheduledMessageUpdate(schedules, update),
      );
      observeDiscussionCatalog(target, discussions);
      observe(
        `subagents:${target.sessionId}`,
        subagents,
        (client) => client.subagents.observe(target.sessionId),
        (update: SubagentUpdate) => applySubagentUpdate(subagents, target.sessionId, update),
      );
    }

    for (const { target, model } of input.discussionCatalogs ?? [])
      observeDiscussionCatalog(target, model);

    for (const { thread, model, tools } of input.discussionSessions ?? []) {
      const sessionId = thread.sidecarSessionId!;
      assertSessionIdentity(model, sessionId);
      const target: DiscussionSessionTarget = {
        parentSessionId: thread.parentSessionId,
        workingDirectory: thread.workingDirectory,
        threadId: thread.id,
      };
      if (tools) Object.assign(target, { tools });
      observe(
        `discussion-session:${sessionId}`,
        model,
        (client) => client.discussionSessions.observe(target),
        (update: DiscussionSessionUpdate) => applyDiscussionSessionUpdate(model, sessionId, update),
        { clear: () => unloadConversationProjection(model) },
      );
    }

    for (const { target, conversation, controls } of input.cakeChats) {
      assertSessionIdentity(conversation, target.sessionId);
      observe(
        `conversation:${target.sessionId}`,
        conversation,
        (client) => client.conversations.observe({ _tag: "CakeChatSession", ...target }),
        (update) => applyConversationUpdate(conversation, update),
        { clear: () => unloadConversationProjection(conversation) },
      );
      observe(
        `cake-chat-controls:${target.sessionId}`,
        controls,
        (client) => client.cakeChats.observeControls(target),
        (update: CakeChatControlUpdate) => applyCakeChatControlUpdate(controls, update),
        {
          clear: () => applyCakeChatControlUpdate(controls, { _tag: "Snapshot", requests: [] }),
        },
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
      const stagedProjectSessionTargets = source.stagedProjectSessionTargets?.() ?? [];
      const stagedIds = new Set(stagedProjectSessionTargets.map(({ sessionId }) => sessionId));
      const loadedProjectSessions = source.loadedProjectSessions?.();
      if (loadedProjectSessions) {
        const loadedIds = new Set(loadedProjectSessions.map(({ sessionId }) => sessionId));
        for (const target of loadedProjectSessions)
          source.projection.projectConversation(target.sessionId, target.workingDirectory);
        const projectionIds = new Set([
          ...source.projection.projectConversations.map(({ sessionId }) => sessionId),
          ...source.projection.discussionCatalogs.map(({ sessionId }) => sessionId),
          ...source.projection.subagentCatalogs.map(({ sessionId }) => sessionId),
          ...source.projection.scheduledMessageCatalogs.map(({ sessionId }) => sessionId),
        ]);
        for (const sessionId of projectionIds)
          if (!loadedIds.has(sessionId))
            source.projection.removeProjectSessionProjections(sessionId, {
              retainDiscussionCatalog: stagedIds.has(sessionId),
            });
      }
      const loadedCakeChatIds = source.loadedCakeChatIds?.();
      if (loadedCakeChatIds) {
        const loadedIds = new Set(loadedCakeChatIds);
        for (const sessionId of loadedCakeChatIds)
          source.projection.cakeChatConversation(sessionId);
        const projectionIds = new Set([
          ...source.projection.cakeChatConversations.map(({ sessionId }) => sessionId),
          ...source.projection.cakeChatControls.map(({ sessionId }) => sessionId),
        ]);
        for (const sessionId of projectionIds)
          if (!loadedIds.has(sessionId)) source.projection.removeCakeChatProjections(sessionId);
      }
      const projectSessions = source.projectSessionTargets().map((target) => ({
        target,
        conversation: source.projection.projectConversation(
          target.sessionId,
          target.workingDirectory,
        ),
        discussions: source.projection.discussionCatalog(target.sessionId),
        subagents: source.projection.subagentCatalog(target.sessionId),
        schedules: source.projection.scheduledMessageCatalog(target.sessionId),
      }));
      const observedIds = new Set(projectSessions.map(({ target }) => target.sessionId));
      const discussionCatalogs = stagedProjectSessionTargets
        .filter((target) => !observedIds.has(target.sessionId))
        .map((target) => ({
          target,
          model: source.projection.discussionCatalog(target.sessionId),
        }));
      // Every observed parent's threads with a sidecar demand its Conversation
      // payload. Conversation Model identity remains window-scoped; leaving
      // retention stops observation and clears payload without reallocating it.
      const liveThreads = [
        ...projectSessions.map(({ discussions }) => discussions),
        ...discussionCatalogs.map(({ model }) => model),
      ].flatMap(({ threads }) => threads.filter(hasSidecarConversation));
      sync({
        projects: source.projection.projects,
        sessionCatalog: source.projection.sessionCatalog,
        worktrees: source.projection.worktrees,
        worktreeOperations: source.projection.worktreeOperations,
        projectSessionCatalogQueries: source.projectSessionCatalogQueries(),
        onProjectSessionTitleChanged: source.onProjectSessionTitleChanged,
        cakeChatCatalog: source.projection.cakeChatCatalog,
        cakeChatCatalogQueries: source.cakeChatCatalogQueries?.(),
        projectSessions,
        discussionCatalogs,
        cakeChats: source.cakeChatTargets().map((target) => ({
          target,
          conversation: source.projection.cakeChatConversation(target.sessionId),
          controls: source.projection.controlsForCakeChat(target.sessionId),
        })),
        discussionSessions: liveThreads.map((thread) => {
          const entry = {
            thread,
            model: source.projection.discussionConversation(
              thread.sidecarSessionId!,
              thread.workingDirectory,
              thread.parentSessionId,
            ),
          };
          if (isSessionAssistantThread(thread))
            Object.assign(entry, { tools: source.sessionAssistantTools?.() ?? [] });
          return entry;
        }),
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

const observationFailureDetails = (key: string, error: unknown) => {
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
    projectSessionCatalogQueries: () =>
      root.sidebarStore.sessionListStore.projectSessionCatalogQueries,
    onProjectSessionTitleChanged: (sessionId, title) =>
      root.sessionRegistry.pendingSessions.applyLiveTitle(sessionId, title),
    cakeChatCatalogQueries: () => root.sidebarStore.sessionListStore.cakeChatCatalogQueries,
    loadedProjectSessions: () =>
      root.sessionRegistry.targets.map(({ sessionId, workspacePath }) => ({
        sessionId,
        workingDirectory: workspacePath,
      })),
    loadedCakeChatIds: () => root.cakeChatCollectionStore.registry.targets,
    projectSessionTargets: () => root.projectSessionObservationTargets,
    stagedProjectSessionTargets: () => root.stagedProjectSessionTargets,
    cakeChatTargets: () => root.cakeChatCollectionStore.registry.observationTargets,
    sessionAssistantTools: () => root.applicationControlStore.sessionAssistantTools(),
  });
  return observer.stop;
};
