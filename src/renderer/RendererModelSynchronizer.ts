import { Effect, Stream } from "effect";
import { applySnapshot, toSnapshot, type Model, type Snapshot } from "r-state-tree";
import type { CakeChatTarget, CakeChatUpdate } from "../domain/cake-chat-data";
import type { ProjectRecord } from "../domain/application-data";
import type { ProjectCatalogUpdate, SessionCatalogUpdate } from "../domain/catalog-data";
import type { ConversationEvent } from "../domain/conversation-data";
import type {
  DiscussionSessionTarget,
  DiscussionSessionUpdate,
  DiscussionThread,
} from "../domain/discussion-session-data";
import type {
  ProjectSessionSummary,
  ProjectSessionTarget,
  ProjectSessionUpdate,
} from "../domain/project-session-data";
import { CakeIpcClient, type CakeIpcClientService } from "../ipc/client/CakeIpcClient";
import { sessionSnapshotSchema, uiPartSchema } from "../ipc/session-contract";
import { toSessionSnapshot } from "../utils/session-snapshot";
import { Message } from "./models/Message";
import { ProjectCatalog } from "./models/ProjectCatalog";
import { ReviewThread } from "./models/ReviewThread";
import { Session } from "./models/Session";
import { SessionCatalog } from "./models/SessionCatalog";
import type { RendererRuntime } from "./RendererRuntime";

interface RevisionedUpdate {
  readonly _tag: "Snapshot" | "Event";
  readonly revision: number;
}

interface Subscription {
  abort: AbortController;
  generation: number;
  revision: number | undefined;
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
  private disposed = false;

  constructor(private readonly runtime: RendererRuntime) {}

  sync(input: {
    readonly projects: ProjectCatalog;
    readonly sessionCatalog: SessionCatalog;
    readonly projectSessions: ReadonlyArray<{ target: ProjectSessionTarget; model: Session }>;
    readonly cakeChats: ReadonlyArray<{ target: CakeChatTarget; model: Session }>;
    readonly discussions: ReadonlyArray<{ target: DiscussionSessionTarget; parent: Session }>;
  }) {
    const active = new Set(["projects", "project-sessions"]);
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
    for (const { target, model } of input.projectSessions) {
      this.assertSessionIdentity(model, target.sessionId, target.workingDirectory);
      const key = `project-session:${target.sessionId}`;
      active.add(key);
      this.synchronizeModel(
        key,
        model,
        (client) => client.projectSessions.observe(target),
        (update: ProjectSessionUpdate) =>
          applyProjectSessionUpdate(model, target.sessionId, update),
      );
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
    for (const { target, parent } of input.discussions) {
      const key = `discussion:${target.threadId}`;
      active.add(key);
      this.synchronizeModel(
        key,
        parent,
        (client) => client.discussionSessions.observe(target),
        (update: DiscussionSessionUpdate) => applyDiscussionUpdate(parent, target.threadId, update),
      );
    }
    for (const key of this.subscriptions.keys()) if (!active.has(key)) this.stop(key);
  }

  [Symbol.dispose]() {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions.values()) subscription.abort.abort();
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
    };
    this.subscriptions.set(key, subscription);
    this.start(key, subscription, stream, apply);
  }

  private stop(key: string) {
    this.subscriptions.get(key)?.abort.abort();
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
              this.start(key, subscription, stream, apply);
              return;
            }
            if (decision === "apply") apply(update);
          }),
        ),
      ),
    );
    void this.runtime.runPromise(consume, { signal: subscription.abort.signal }).catch(() => {
      if (
        !this.disposed &&
        this.subscriptions.get(key) === subscription &&
        generation === subscription.generation &&
        !subscription.abort.signal.aborted
      )
        this.start(key, subscription, stream, apply);
    });
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

type SessionSummarySnapshot = ProjectSessionSummary & {
  readonly pending: boolean;
  readonly draft: boolean;
};

function sessionSummarySnapshot(
  session: SessionCatalog["sessions"][number],
): SessionSummarySnapshot {
  const snapshot: SessionSummarySnapshot = {
    sessionId: session.sessionId,
    title: session.title,
    createdAt: session.createdAt,
    modifiedAt: session.modifiedAt,
    messageCount: session.messageCount,
    resolved: session.resolved,
    unread: session.unread,
    projectPath: session.projectPath,
    projectName: session.projectName,
    workingDirectory: session.workingDirectory,
    pending: session.pending,
    draft: session.draft,
  };
  if (session.parentSessionId !== undefined)
    Object.assign(snapshot, { parentSessionId: session.parentSessionId });
  if (session.managedWorktree !== undefined)
    Object.assign(snapshot, { managedWorktree: session.managedWorktree });
  return snapshot;
}

function authoritativeSessionSnapshot(session: ProjectSessionSummary): SessionSummarySnapshot {
  return { ...session, pending: false, draft: false };
}

function applySessionCatalogUpdate(model: SessionCatalog, update: SessionCatalogUpdate) {
  const current = model.sessions.map(sessionSummarySnapshot);
  const pending = current.filter((session) => session.pending);
  let authoritative = current.filter((session) => !session.pending);
  if (update._tag === "Snapshot") authoritative = update.sessions.map(authoritativeSessionSnapshot);
  else {
    const event = update.event;
    if (event._tag === "Replaced") authoritative = event.sessions.map(authoritativeSessionSnapshot);
    else if (event._tag === "Upserted") {
      const snapshot = authoritativeSessionSnapshot(event.session);
      const index = authoritative.findIndex((session) => session.sessionId === snapshot.sessionId);
      if (index >= 0) authoritative[index] = snapshot;
      else authoritative.push(snapshot);
    } else if (event._tag === "Removed")
      authoritative = authoritative.filter((session) => session.sessionId !== event.sessionId);
    else
      authoritative = authoritative.map((session) =>
        session.sessionId === event.sessionId
          ? { ...session, resolved: event.resolved, unread: event.unread }
          : session,
      );
  }
  const authoritativeIds = new Set(authoritative.map((session) => session.sessionId));
  const sessions = [
    ...authoritative,
    ...pending.filter((session) => !authoritativeIds.has(session.sessionId)),
  ].sort((left, right) => {
    if (left.resolved !== right.resolved) return left.resolved ? 1 : -1;
    return right.modifiedAt.localeCompare(left.modifiedAt);
  });
  assertUnique(
    sessions.map((session) => session.sessionId),
    "Session ID",
  );
  applySnapshot(model, { sessions });
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
    applySnapshot(model, toSessionSnapshot(update.snapshot.conversation));
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
    applySnapshot(model, toSessionSnapshot(update.snapshot.conversation));
    return;
  }
  if (update.sessionId !== sessionId)
    throw new Error(`Cake Chat event identity collision: ${sessionId}`);
  const event = update.event;
  if (event._tag === "ControlRequested") {
    if (
      !model.controlRequests.some((request) => request.controlRequestId === event.controlRequestId)
    )
      applySnapshot(model, {
        ...toSnapshot(model),
        // SAFETY: controlRequests is the exact Session field represented by this snapshot property.
        controlRequests: [...model.controlRequests, event] as Snapshot<Session>["controlRequests"],
      });
    return;
  }
  applyConversationEvent(model, event);
}

function applyConversationEvent(model: Session, event: ConversationEvent) {
  if (event._tag === "SnapshotUpdated") {
    applySnapshot(model, toSessionSnapshot(event.snapshot));
    return;
  }
  if (event._tag === "PartUpdated") {
    const part = uiPartSchema.parse(event.part);
    const parts = [...model.uiParts];
    const index = parts.findIndex((current) => current.id === part.id);
    if (index >= 0) parts[index] = part;
    else parts.push(part);
    applySnapshot(model, {
      ...toSnapshot(model),
      parts: messageSnapshots(parts),
    });
  } else if (event._tag === "PartRemoved")
    applySnapshot(model, {
      ...toSnapshot(model),
      parts: messageSnapshots(model.uiParts.filter((part) => part.id !== event.partId)),
    });
  else if (event._tag === "StreamingChanged")
    applySnapshot(model, { ...toSnapshot(model), streaming: event.streaming });
}

function applyDiscussionUpdate(parent: Session, threadId: string, update: DiscussionSessionUpdate) {
  const existing = parent.reviewThreads.find((thread) => thread.id === threadId);
  if (update._tag === "Snapshot") {
    const snapshot = discussionSnapshot(update.snapshot.thread, update.snapshot.conversation);
    if (existing) applySnapshot(existing, snapshot);
    else
      applySnapshot(parent, {
        ...toSnapshot(parent),
        reviewThreads: [...parent.reviewThreads.map((thread) => toSnapshot(thread)), snapshot],
      });
    return;
  }
  if (!existing || update.threadId !== threadId) return;
  const event = update.event;
  if (event._tag === "SnapshotUpdated") {
    applySnapshot(existing, discussionSnapshot(toDiscussionThread(existing), event.snapshot));
    return;
  }
  const snapshot = toSnapshot(existing);
  if (event._tag === "PartUpdated") {
    const part = uiPartSchema.parse(event.part);
    const parts = [...existing.uiParts];
    const index = parts.findIndex((current) => current.id === part.id);
    if (index >= 0) parts[index] = part;
    else parts.push(part);
    applySnapshot(existing, { ...snapshot, parts: messageSnapshots(parts) });
  } else if (event._tag === "PartRemoved")
    applySnapshot(existing, {
      ...snapshot,
      parts: messageSnapshots(existing.uiParts.filter((part) => part.id !== event.partId)),
    });
  else if (event._tag === "StreamingChanged")
    applySnapshot(existing, { ...snapshot, streaming: event.streaming });
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
      : sessionSnapshotSchema.shape.usage.parse(conversation.usage);
  const snapshot = {
    ...thread,
    parts: messageSnapshots(
      (conversation?.parts ?? thread.parts).map((part) => uiPartSchema.parse(part)),
    ),
    streaming: conversation?.streaming ?? false,
  };
  if (usage !== undefined) Object.assign(snapshot, { usage });
  // SAFETY: every ReviewThread field is populated from its validated domain record and UiPart schema.
  return snapshot as Snapshot<ReviewThread>;
}

function messageSnapshots(parts: ReturnType<typeof uiPartSchema.parse>[]): Snapshot<Message>[] {
  // SAFETY: Message's persisted fields are exactly the validated UiPart discriminated union.
  return parts as Snapshot<Message>[];
}

function assertUnique(values: readonly string[], label: string) {
  const unique = new Set(values);
  if (unique.size !== values.length) throw new Error(`${label} collision`);
}
