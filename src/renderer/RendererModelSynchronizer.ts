import { Effect, Stream, Schema } from "effect";
import {
  applySnapshot,
  effect as reactiveEffect,
  toSnapshot,
  type Model,
  type Snapshot,
} from "r-state-tree";
import type { CakeChatTarget, CakeChatUpdate } from "../domain/cake-chat-data";
import type { ProjectRecord } from "../domain/application-data";
import type {
  CakeChatCatalogUpdate,
  DiscussionCatalogUpdate,
  ProjectCatalogUpdate,
  SessionCatalogUpdate,
} from "../domain/catalog-data";
import type { ConversationEvent } from "../domain/conversation-data";
import type {
  DiscussionSessionTarget,
  DiscussionSessionUpdate,
  DiscussionThread,
} from "../domain/discussion-session-data";
import type { ProjectSessionTarget, ProjectSessionUpdate } from "../domain/project-session-data";
import { ProjectSessionError } from "../domain/project-session-data";
import type {
  SubagentActivity as SubagentActivityValue,
  SubagentUpdate,
} from "../domain/subagent-data";
import { CakeIpcClient, type CakeIpcClientService } from "../ipc/client/CakeIpcClient";
import {
  extensionUiEventSchema,
  sessionSnapshotSchema,
  uiPartSchema,
} from "../ipc/session-contract";
import { artifactSnapshot, toSessionSnapshot } from "../utils/session-snapshot";
import type { ArtifactRecord } from "../ipc/artifact-contract";
import type { CakeChatCatalog } from "./models/CakeChatCatalog";
import type { Message } from "./models/Message";
import type { ProjectCatalog } from "./models/ProjectCatalog";
import type { ReviewThread } from "./models/ReviewThread";
import type { Session } from "./models/Session";
import type { SessionCatalog } from "./models/SessionCatalog";
import type { SubagentActivity } from "./models/SubagentActivity";
import type { RendererRuntime } from "./RendererRuntime";

export interface RendererModelSource {
  readonly projects: ProjectCatalog;
  readonly sessionCatalog: SessionCatalog;
  readonly cakeChatCatalog: CakeChatCatalog;
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
  abort: AbortController;
  generation: number;
  revision: number | undefined;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
}

type StreamFactory<Update> = (client: CakeIpcClientService) => Stream.Stream<Update, unknown>;

/**
 * The renderer's one Stream-to-Model boundary. It listens to authoritative RPC
 * Streams and synchronizes passive r-state-tree Models exclusively through
 * applySnapshot. Stores and Models never see Effect, RPC, revisions, or Fibers.
 */
export class RendererModelSynchronizer implements Disposable {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly models = new Map<string, Model>();
  private stopObservingSource: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly runtime: RendererRuntime) {}

  /** Watches loaded Models from renderer infrastructure, outside the Store tree. */
  observe(source: RendererModelSource) {
    if (this.stopObservingSource)
      throw new Error("Renderer Model synchronization already has a Model source");
    this.stopObservingSource = reactiveEffect(() => {
      this.sync({
        projects: source.projects,
        sessionCatalog: source.sessionCatalog,
        cakeChatCatalog: source.cakeChatCatalog,
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
    const session = model as Session;
    const current = toSnapshot(session);
    // SAFETY: current is Session's canonical snapshot and record crossed artifactRecordSchema.
    const next = {
      ...current,
      artifacts: [
        ...(current.artifacts ?? []).filter((artifact) => artifact.id !== record.artifact.id),
        artifactSnapshot(record),
      ],
    } as Snapshot<Session>;
    applySnapshot(session, next);
  }

  sync(input: {
    readonly projects: ProjectCatalog;
    readonly sessionCatalog: SessionCatalog;
    readonly cakeChatCatalog: CakeChatCatalog;
    readonly projectSessions: ReadonlyArray<{ target: ProjectSessionTarget; model: Session }>;
    readonly cakeChats: ReadonlyArray<{ target: CakeChatTarget; model: Session }>;
  }) {
    const active = new Set(["projects", "project-sessions", "cake-chats"]);
    this.synchronizeModel(
      "projects",
      input.projects,
      (client) => client.projects.observeCatalog(),
      (update: ProjectCatalogUpdate) => applyProjectCatalogUpdate(input.projects, update),
    );
    this.synchronizeModel(
      "project-sessions",
      input.sessionCatalog,
      (client) => client.projectSessions.observeCatalog(),
      (update: SessionCatalogUpdate) => applySessionCatalogUpdate(input.sessionCatalog, update),
    );

    this.synchronizeModel(
      "cake-chats",
      input.cakeChatCatalog,
      (client) => client.cakeChats.observeCatalog(),
      (update: CakeChatCatalogUpdate) => applyCakeChatCatalogUpdate(input.cakeChatCatalog, update),
    );

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
    for (const subscription of this.subscriptions.values()) {
      subscription.abort.abort();
      if (subscription.retryTimer) clearTimeout(subscription.retryTimer);
    }
    this.subscriptions.clear();
    this.models.clear();
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
    const subscription: Subscription = {
      abort: new AbortController(),
      generation: 0,
      revision: undefined,
      retryTimer: undefined,
    };
    this.subscriptions.set(key, subscription);
    this.start(key, subscription, stream, apply);
  }

  private stop(key: string) {
    const subscription = this.subscriptions.get(key);
    subscription?.abort.abort();
    if (subscription?.retryTimer) clearTimeout(subscription.retryTimer);
    this.subscriptions.delete(key);
    this.models.delete(key);
  }

  private start<Update extends RevisionedUpdate>(
    key: string,
    subscription: Subscription,
    stream: StreamFactory<Update>,
    apply: (update: Update) => void,
  ) {
    subscription.abort.abort();
    if (subscription.retryTimer) clearTimeout(subscription.retryTimer);
    subscription.retryTimer = undefined;
    subscription.abort = new AbortController();
    subscription.generation += 1;
    subscription.revision = undefined;
    const generation = subscription.generation;
    const consume = Effect.flatMap(CakeIpcClient, (client) =>
      stream(client).pipe(
        Stream.runForEach((update) =>
          Effect.sync(() => {
            const decision = this.accept(subscription, generation, update);
            if (decision === "restart") {
              this.scheduleRestart(key, subscription, generation, stream, apply);
              return;
            }
            if (decision === "apply") apply(update);
          }),
        ),
      ),
    );
    void this.runtime.runPromise(consume, { signal: subscription.abort.signal }).catch((error) => {
      if (
        !this.disposed &&
        this.subscriptions.get(key) === subscription &&
        generation === subscription.generation &&
        !subscription.abort.signal.aborted
      ) {
        if (isUnavailableProjectSessionObservation(key, error)) {
          this.stop(key);
          return;
        }
        console.error(`[cake.renderer] ${key} synchronization failed`, error);
        this.scheduleRestart(key, subscription, generation, stream, apply);
      }
    });
  }

  private scheduleRestart<Update extends RevisionedUpdate>(
    key: string,
    subscription: Subscription,
    generation: number,
    stream: StreamFactory<Update>,
    apply: (update: Update) => void,
  ) {
    if (subscription.retryTimer || generation !== subscription.generation) return;
    subscription.abort.abort();
    subscription.retryTimer = setTimeout(() => {
      subscription.retryTimer = undefined;
      if (!this.disposed && this.subscriptions.get(key) === subscription)
        this.start(key, subscription, stream, apply);
    }, 250);
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
    if (workingDirectory && model.workingDirectory && model.workingDirectory !== workingDirectory)
      throw new Error(`Session Model Working Directory collision: ${sessionId}`);
  }
}

const isUnavailableProjectSessionObservation = (key: string, error: unknown) =>
  key.startsWith("project-session:") &&
  Schema.is(ProjectSessionError)(error) &&
  error.operation === "observe" &&
  error.message === "That session is no longer available";

function applyProjectCatalogUpdate(model: ProjectCatalog, update: ProjectCatalogUpdate) {
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

function applySessionCatalogUpdate(model: SessionCatalog, update: SessionCatalogUpdate) {
  if (update._tag === "Event" && update.event._tag === "StatusChanged") {
    const event = update.event;
    const session = model.find(event.sessionId);
    if (!session) return;
    applySnapshot(session, {
      ...toSnapshot(session),
      resolved: event.resolved,
      unread: event.unread,
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

const compareSessionSummaries = (
  left: { readonly resolved?: boolean | null; readonly modifiedAt?: string | null },
  right: { readonly resolved?: boolean | null; readonly modifiedAt?: string | null },
) => {
  const leftResolved = left.resolved === true;
  const rightResolved = right.resolved === true;
  if (leftResolved !== rightResolved) return leftResolved ? 1 : -1;
  return (right.modifiedAt ?? "").localeCompare(left.modifiedAt ?? "");
};

function applyCakeChatCatalogUpdate(model: CakeChatCatalog, update: CakeChatCatalogUpdate) {
  const sessions = update._tag === "Snapshot" ? update.sessions : update.event.sessions;
  assertUnique(
    sessions.map((session) => session.sessionId),
    "Cake Chat Session ID",
  );
  applySnapshot(model, { loaded: true, sessions: [...sessions] });
}

function applyProjectSessionUpdate(
  model: Session,
  sessionId: string,
  update: ProjectSessionUpdate,
) {
  if (update._tag === "Snapshot") {
    if (
      update.snapshot.identity._tag !== "ProjectSession" ||
      update.snapshot.identity.sessionId !== sessionId
    )
      throw new Error(`Project Session identity collision: ${sessionId}`);
    applyConversationSnapshot(model, update.snapshot.conversation);
    return;
  }
  if (update.sessionId !== sessionId)
    throw new Error(`Project Session event identity collision: ${sessionId}`);
  applyConversationEvent(model, update.event);
}

function applyCakeChatUpdate(model: Session, sessionId: string, update: CakeChatUpdate) {
  if (update._tag === "Snapshot") {
    if (
      update.snapshot.identity._tag !== "CakeChatSession" ||
      update.snapshot.identity.sessionId !== sessionId
    )
      throw new Error(`Cake Chat identity collision: ${sessionId}`);
    applyConversationSnapshot(model, update.snapshot.conversation);
    return;
  }
  if (update.sessionId !== sessionId)
    throw new Error(`Cake Chat event identity collision: ${sessionId}`);
  const event = update.event;
  if (event._tag === "ControlRequested") {
    if (
      !model.controlRequests.some((request) => request.controlRequestId === event.controlRequestId)
    ) {
      // SAFETY: ControlRequested is the exact validated element type of Session.controlRequests.
      const controlRequests = [
        ...model.controlRequests,
        event,
      ] as Snapshot<Session>["controlRequests"];
      applySnapshot(model, { ...toSnapshot(model), controlRequests });
    }
    return;
  }
  applyConversationEvent(model, event);
}

function applyConversationSnapshot(
  model: Session,
  conversation: Parameters<typeof toSessionSnapshot>[0],
) {
  const current = toSnapshot(model);
  const authoritative = toSessionSnapshot(conversation);
  applySnapshot(model, {
    ...authoritative,
    reviewThreads: current.reviewThreads,
    subagentActivities: current.subagentActivities,
    releasedSubagentHandleIds: current.releasedSubagentHandleIds,
    backgroundWorkActive: current.backgroundWorkActive,
    controlRequests: current.controlRequests,
    extensionUi: {
      ...authoritative.extensionUi,
      notifications: current.extensionUi!.notifications,
      compatibilityDiagnostics: current.extensionUi!.compatibilityDiagnostics,
      editorText: current.extensionUi!.editorText,
      editorTextRevision: current.extensionUi!.editorTextRevision,
    },
  });
}

function applyConversationEvent(model: Session, event: ConversationEvent) {
  if (event._tag === "SnapshotUpdated") {
    applyConversationSnapshot(model, event.snapshot);
    return;
  }
  const snapshot = toSnapshot(model);
  if (event._tag === "PartUpdated") {
    const part = Schema.decodeUnknownSync(uiPartSchema)(event.part);
    const parts = [...model.uiParts];
    const index = parts.findIndex((current) => current.id === part.id);
    if (index >= 0) parts[index] = part;
    else parts.push(part);
    applySnapshot(model, { ...snapshot, parts: messageSnapshots(parts) });
  } else if (event._tag === "PartRemoved")
    applySnapshot(model, {
      ...snapshot,
      parts: messageSnapshots(model.uiParts.filter((part) => part.id !== event.partId)),
    });
  else if (event._tag === "StreamingChanged")
    applySnapshot(model, { ...snapshot, streaming: event.streaming });
  else if (event._tag === "ExtensionUi")
    applySnapshot(model, {
      ...snapshot,
      extensionUi: extensionUiSnapshot(
        snapshot.extensionUi!,
        Schema.decodeUnknownSync(extensionUiEventSchema)(event.event),
      ),
    });
}

function extensionUiSnapshot(
  current: NonNullable<Snapshot<Session>["extensionUi"]>,
  event: typeof extensionUiEventSchema.Type,
): NonNullable<Snapshot<Session>["extensionUi"]> {
  if (event.kind === "notify") {
    const notifications = [...current.notifications!.filter((item) => item.id !== event.id), event];
    return { ...current, notifications: notifications.slice(-8) };
  }
  if (event.kind === "status") {
    const statuses = current.statuses!.filter((item) => item.key !== event.key);
    if (event.text !== undefined) statuses.push({ key: event.key, text: event.text });
    return { ...current, statuses };
  }
  if (event.kind === "title") return { ...current, title: event.title };
  if (event.kind === "editor-text")
    return {
      ...current,
      editorText: { text: event.text, mode: event.mode },
      editorTextRevision: current.editorTextRevision! + 1,
    };
  const diagnostics = current.compatibilityDiagnostics!.some(
    (item) => item.id === event.diagnostic.id,
  )
    ? current.compatibilityDiagnostics!
    : [...current.compatibilityDiagnostics!, event.diagnostic];
  return { ...current, compatibilityDiagnostics: diagnostics };
}

function applyDiscussionCatalogUpdate(
  model: Session,
  sessionId: string,
  update: DiscussionCatalogUpdate,
) {
  if (update.parentSessionId !== sessionId)
    throw new Error(`Discussion catalog identity collision: ${sessionId}`);
  const threads = update._tag === "Snapshot" ? update.threads : update.event.threads;
  assertUnique(
    threads.map((thread) => thread.id),
    "Discussion thread ID",
  );
  applySnapshot(model, {
    ...toSnapshot(model),
    reviewThreads: threads.map((thread) => discussionSnapshot(thread)),
  });
}

function applyDiscussionUpdate(
  model: ReviewThread,
  threadId: string,
  update: DiscussionSessionUpdate,
) {
  if (update._tag === "Snapshot") {
    if (update.snapshot.thread.id !== threadId)
      throw new Error(`Discussion identity collision: ${threadId}`);
    applySnapshot(model, discussionSnapshot(update.snapshot.thread, update.snapshot.conversation));
    return;
  }
  if (update.threadId !== threadId)
    throw new Error(`Discussion event identity collision: ${threadId}`);
  const event = update.event;
  if (event._tag === "SnapshotUpdated") {
    applySnapshot(model, discussionSnapshot(toDiscussionThread(model), event.snapshot));
    return;
  }
  const snapshot = toSnapshot(model);
  if (event._tag === "PartUpdated") {
    const part = Schema.decodeUnknownSync(uiPartSchema)(event.part);
    const parts = [...model.uiParts];
    const index = parts.findIndex((current) => current.id === part.id);
    if (index >= 0) parts[index] = part;
    else parts.push(part);
    applySnapshot(model, { ...snapshot, parts: messageSnapshots(parts) });
  } else if (event._tag === "PartRemoved")
    applySnapshot(model, {
      ...snapshot,
      parts: messageSnapshots(model.uiParts.filter((part) => part.id !== event.partId)),
    });
  else if (event._tag === "StreamingChanged")
    applySnapshot(model, { ...snapshot, streaming: event.streaming });
}

function applySubagentUpdate(model: Session, sessionId: string, update: SubagentUpdate) {
  if (update.parentSessionId !== sessionId)
    throw new Error(`Subagent parent identity collision: ${sessionId}`);
  const snapshot = toSnapshot(model);
  const activities = model.subagentActivities.map(subagentModelSnapshot);
  let releasedSubagentHandleIds = [...model.releasedSubagentHandleIds];
  let backgroundWorkActive = model.backgroundWorkActive;
  if (update._tag === "Snapshot") {
    activities.splice(0, activities.length, ...update.activities.map(subagentSnapshot));
    releasedSubagentHandleIds = releasedSubagentHandleIds.filter(
      (handleId) => !update.activities.some((activity) => activity.handleId === handleId),
    );
    backgroundWorkActive = update.backgroundActive;
  } else if (update._tag === "Activity") {
    const next = subagentSnapshot(update.activity);
    const index = activities.findIndex((activity) => activity.handleId === next.handleId);
    if (index >= 0) activities[index] = next;
    else activities.push(next);
    releasedSubagentHandleIds = releasedSubagentHandleIds.filter(
      (handleId) => handleId !== update.activity.handleId,
    );
  } else if (update._tag === "Removed") {
    const index = activities.findIndex((activity) => activity.handleId === update.handleId);
    if (index >= 0) activities.splice(index, 1);
    if (!releasedSubagentHandleIds.includes(update.handleId))
      releasedSubagentHandleIds.push(update.handleId);
  } else backgroundWorkActive = update.active;
  assertUnique(
    activities
      .map((activity) => activity.handleId)
      .filter((handleId): handleId is string => typeof handleId === "string"),
    "Subagent handle ID",
  );
  applySnapshot(model, {
    ...snapshot,
    subagentActivities: activities,
    releasedSubagentHandleIds,
    backgroundWorkActive,
  });
}

function subagentModelSnapshot(activity: SubagentActivity): Snapshot<SubagentActivity> {
  const snapshot = {
    parentSessionId: activity.parentSessionId,
    anchorPartId: activity.anchorPartId,
    handleId: activity.handleId,
    revision: activity.revision,
    task: activity.task,
    profile: activity.profile,
    status: activity.status,
    resolvedModel: activity.resolvedModel,
    fastMode: activity.fastMode,
    retained: activity.retained,
    streaming: activity.streaming,
    parts: activity.parts,
    usage: activity.usage,
    error: activity.error,
  };
  // SAFETY: every field is read from the already validated SubagentActivity Model.
  return snapshot as Snapshot<SubagentActivity>;
}

function subagentSnapshot(activity: SubagentActivityValue): Snapshot<SubagentActivity> {
  const snapshot = {
    ...activity,
    parts: activity.parts.map((part) => Schema.decodeUnknownSync(uiPartSchema)(part)),
    usage:
      activity.usage === undefined
        ? undefined
        : Schema.decodeUnknownSync(sessionSnapshotSchema.fields.usage)(activity.usage),
  };
  // SAFETY: every field is populated from the validated Subagent activity RPC value.
  return snapshot as Snapshot<SubagentActivity>;
}

function toDiscussionThread(thread: ReviewThread): DiscussionThread {
  const snapshot: DiscussionThread = {
    id: thread.id,
    workingDirectory: thread.workingDirectory,
    parentSessionId: thread.parentSessionId,
    anchor: thread.anchor,
    parts: thread.uiParts,
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
  if (thread.sidecarSessionId !== undefined)
    Object.assign(snapshot, { sidecarSessionId: thread.sidecarSessionId });
  if (thread.usage !== undefined) Object.assign(snapshot, { usage: thread.usage });
  if (thread.resolvedAt !== undefined) Object.assign(snapshot, { resolvedAt: thread.resolvedAt });
  return snapshot;
}

function discussionSnapshot(
  thread: DiscussionThread,
  conversation?: {
    readonly parts: readonly unknown[];
    readonly usage?: unknown;
    readonly streaming: boolean;
  },
): Snapshot<ReviewThread> {
  const usage =
    conversation?.usage === undefined
      ? thread.usage
      : Schema.decodeUnknownSync(sessionSnapshotSchema.fields.usage)(conversation.usage);
  const snapshot = {
    ...thread,
    parts: messageSnapshots(
      (conversation?.parts ?? thread.parts).map((part) =>
        Schema.decodeUnknownSync(uiPartSchema)(part),
      ),
    ),
    streaming: conversation?.streaming ?? false,
  };
  if (usage !== undefined) Object.assign(snapshot, { usage });
  // SAFETY: every ReviewThread field is populated from validated Discussion and UiPart values.
  return snapshot as Snapshot<ReviewThread>;
}

function messageSnapshots(parts: ReadonlyArray<typeof uiPartSchema.Type>): Snapshot<Message>[] {
  // SAFETY: Message's snapshot variants are exactly the validated UiPart union.
  return parts as Snapshot<Message>[];
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} collision`);
}
