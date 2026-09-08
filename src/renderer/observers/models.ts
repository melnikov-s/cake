import { Schema, type Stream } from "effect";
import { effect as reactiveEffect, type Model } from "r-state-tree";
import type {
  CakeChatCatalogQuery,
  CakeChatTarget,
  CakeChatUpdate,
} from "../../domain/cake-chat-data";
import type {
  CakeChatCatalogUpdate,
  DiscussionCatalogUpdate,
  ProjectCatalogUpdate,
  SessionCatalogUpdate,
} from "../../domain/catalog-data";
import type {
  DiscussionSessionTarget,
  DiscussionSessionUpdate,
} from "../../domain/discussion-session-data";
import type {
  ProjectSessionCatalogQuery,
  ProjectSessionTarget,
  ProjectSessionUpdate,
} from "../../domain/project-session-data";
import { ProjectSessionError } from "../../domain/project-session-data";
import type { SubagentUpdate } from "../../domain/subagent-data";
import type { ScheduledMessageUpdate } from "../../domain/scheduled-message-data";
import type { CakeIpcClientService } from "../../ipc/client/CakeIpcClient";
import type { RendererRuntime } from "../RendererRuntime";
import type { RootStore } from "../stores/RootStore";
import type { CakeChatCatalog } from "../models/CakeChatCatalog";
import type { ProjectCatalog } from "../models/ProjectCatalog";
import type { RootProjection } from "../models/RootProjection";
import type { Session } from "../models/Session";
import type { SessionCatalog } from "../models/SessionCatalog";
import {
  applyCakeChatCatalogGroupUpdate,
  applyProjectCatalogUpdate,
  applySessionCatalogGroupUpdate,
} from "../reducers/CatalogReducer";
import { applyCakeChatUpdate, applyProjectSessionUpdate } from "../reducers/ConversationReducer";
import { applyDiscussionCatalogUpdate, applyDiscussionUpdate } from "../reducers/DiscussionReducer";
import { applySubagentUpdate } from "../reducers/SubagentReducer";
import { applyScheduledMessageUpdate } from "../reducers/ScheduledMessageReducer";
import type { StreamFailureAction } from "./observe-stream";

type ObservedProjectSessionTarget = ProjectSessionTarget & { readonly workingDirectory: string };

interface ModelSource {
  readonly projection: RootProjection;
  readonly projectSessionCatalogQueries: () => ReadonlyArray<ProjectSessionCatalogQuery>;
  readonly cakeChatCatalogQueries?: () => ReadonlyArray<CakeChatCatalogQuery>;
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
  readonly projectSessionCatalogQueries?: ReadonlyArray<ProjectSessionCatalogQuery>;
  readonly cakeChatCatalog: CakeChatCatalog;
  readonly cakeChatCatalogQueries?: ReadonlyArray<CakeChatCatalogQuery>;
  readonly projectSessions: ReadonlyArray<{ target: ProjectSessionTarget; model: Session }>;
  readonly cakeChats: ReadonlyArray<{ target: CakeChatTarget; model: Session }>;
};

/** Creates the window's dynamic observer for passive projection Models. */
export const createModelObserver = (runtime: RendererRuntime) => {
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
      sync({
        projects: source.projection.projects,
        sessionCatalog: source.projection.sessionCatalog,
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

/** Observes the Models demanded by one renderer window's Store tree. */
export const observeModels = (
  runtime: RendererRuntime,
  projection: RootProjection,
  root: RootStore,
) => {
  const observer = createModelObserver(runtime);
  observer.observe({
    projection,
    projectSessionCatalogQueries: () => root.projectSessionCatalogQueries,
    cakeChatCatalogQueries: () => root.sidebarStore.cakeChatCatalogQueries,
    projectSessionTargets: () => root.projectSessionObservationTargets,
    cakeChatTargets: () => root.cakeChatCollectionStore.observationTargets,
  });
  return observer.stop;
};
