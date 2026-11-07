import type { Project } from "../models/Project";
import { applyCakeChatCatalogGroupUpdate } from "../reducers/CatalogReducer";
import type { CakeChatTodoList } from "../models/CakeChatTodoList";
import { Store, child, createStore, observable } from "r-state-tree";
import { settledSessionActivity, type SessionActivity } from "../lib/session-activity";
import {
  CAKE_CHAT_SESSION_ID,
  isProjectChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import type {
  ChatConfiguration,
  ModelPreset,
} from "../../contracts/conversations/session-contract";
import { compareSessionSummariesForSidebar } from "../../utils/session-summary-order";
import { describeError } from "../lib/error-details";
import type { CakeChatCatalog } from "../models/CakeChatCatalog";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import type { Conversation } from "../models/Conversation";
import type { CakeChatControls } from "../models/CakeChatControls";
import type { SubagentCatalog } from "../models/SubagentCatalog";
import type { DiscussionCatalog } from "../models/DiscussionCatalog";
import {
  CakeChatPendingSessionsStore,
  type CakeChatSummaryProjection,
  type CakeControlTool,
} from "./CakeChatPendingSessionsStore";
import { CakeChatRegistryStore } from "./CakeChatRegistryStore";
import { ClientContext } from "./context/ClientContext";
import type { ScheduledMessageCatalog } from "../models/ScheduledMessageCatalog";
import { SessionLayoutStore } from "./SessionLayoutStore";
import { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface CakeChatCollectionStoreProps {
  catalog: CakeChatCatalog;
  artifactModel: ArtifactCatalog;
  projectForChat?(sessionId: string): Project | undefined;
  /** Global Cake Chat's own to-do list projection. */
  cakeChatTodos?(): CakeChatTodoList;
  sessionModel(sessionId: string): Conversation;
  controlsModel(sessionId: string): CakeChatControls;
  subagentCatalog(sessionId: string): SubagentCatalog;
  scheduledMessageCatalog(sessionId: string): ScheduledMessageCatalog;
  discussionCatalog(sessionId: string): DiscussionCatalog;
  discussionSessionModel(
    sessionId: string,
    workingDirectory: string,
    parentSessionId: string,
  ): Conversation;
  tools(): ReadonlyArray<CakeControlTool>;
  modelPresets?(): readonly ModelPreset[];
  defaultConfiguration?(): ChatConfiguration | undefined;
  openModelPresetSettings?(): void;

  projectChatLayout(): SessionLayoutStore;
  selectedProjectChatId(): string | undefined;
  isSelected(): boolean;
}

/** Coordinates Cake Chat catalog initialization, focused children, and split-layout integration. */
export class CakeChatCollectionStore extends Store<CakeChatCollectionStoreProps> {
  hydrated = false;
  error: string | undefined;
  errorDetails: string | undefined;
  private initialization: Promise<void> | undefined;
  private resolveInitialization: (() => void) | undefined;
  private initializing = false;
  private selectionRevision = 0;
  /** Same window-local completion acknowledgement as Project Sessions, not transcript storage. */
  private readonly readSettledTurnRevisions: Map<string, number> = observable(new Map());
  /** Read/reminder writes are serialized; authoritative catalog updates supply their projection. */
  private unreadUpdates: Promise<void> = Promise.resolve();

  @child
  get operations(): SessionOperationCoordinatorStore {
    return createStore(SessionOperationCoordinatorStore);
  }

  @child
  get sessionLayoutStore(): SessionLayoutStore {
    return createStore(SessionLayoutStore);
  }

  @child
  get pendingSessions(): CakeChatPendingSessionsStore {
    return createStore(CakeChatPendingSessionsStore, {
      defaultConfiguration: this.props.defaultConfiguration,
    });
  }

  @child
  get registry(): CakeChatRegistryStore {
    return createStore(CakeChatRegistryStore, {
      projectForChat: this.props.projectForChat,
      cakeChatTodos: this.props.cakeChatTodos,
      sessionModel: this.props.sessionModel,
      artifactModel: this.props.artifactModel,
      controlsModel: this.props.controlsModel,
      subagentCatalog: this.props.subagentCatalog,
      scheduledMessageCatalog: this.props.scheduledMessageCatalog,
      discussionCatalog: this.props.discussionCatalog,
      discussionSessionModel: this.props.discussionSessionModel,
      tools: this.props.tools,
      pendingSessions: () => this.pendingSessions,
      operations: this.operations,
      isVisible: (sessionId) => this.layoutFor(sessionId).focusedSessionId === sessionId,
      modelPresets: this.props.modelPresets,
      openModelPresetSettings: this.props.openModelPresetSettings,
    });
  }

  get client() {
    return ClientContext.consume(this)!;
  }

  /** Permanent Project Chats share the Project Session pane layout, retaining Cake Chat identity. */
  layoutFor(sessionId: string) {
    return isProjectChatSessionId(sessionId)
      ? this.props.projectChatLayout()
      : this.sessionLayoutStore;
  }

  get sessionId() {
    return this.props.selectedProjectChatId() ?? this.sessionLayoutStore.focusedSessionId;
  }

  get hasMoreResolvedSessions() {
    return this.props.catalog.resolvedHasMore;
  }

  get summaries(): readonly CakeChatSummaryProjection[] {
    const authoritative: CakeChatSummaryProjection[] = [...this.props.catalog.sessions];
    const authoritativeIds = new Set(authoritative.map((session) => session.sessionId));
    authoritative.push(
      ...this.pendingSessions.summaries.filter(
        (session) => !authoritativeIds.has(session.sessionId),
      ),
    );
    return authoritative.sort(compareSessionSummariesForSidebar);
  }

  get activeSession() {
    return this.sessionId ? this.registry.find(this.sessionId) : undefined;
  }

  get activity(): SessionActivity | undefined {
    return this.activityFor(CAKE_CHAT_SESSION_ID);
  }

  activityFor(sessionId: string): SessionActivity | undefined {
    const subagents = this.props.subagentCatalog(sessionId);
    if (
      subagents.activities.some(
        (activity) =>
          !subagents.releasedHandleIds.includes(activity.handleId) &&
          (activity.status === "queued" || activity.status === "running"),
      )
    )
      return "running";
    return this.ownActivityFor(sessionId);
  }

  /** The owner's own activity, deliberately excluding running descendants. */
  ownActivityFor(sessionId: string): SessionActivity | undefined {
    const model = this.props.sessionModel(sessionId);
    if (model.streaming || model.activeTurnIds.length > 0) return "running";
    const settled = settledSessionActivity(model.settledTurns.at(-1)?.outcome, model.parts);
    // Reading acknowledges a response, not an unresolved execution failure.
    if (settled === "error" || settled === "stopped") return settled;
    if (
      !(this.props.isSelected() && this.sessionId === sessionId) &&
      model.settledTurnRevision > (this.readSettledTurnRevisions.get(sessionId) ?? 0)
    )
      return settled;
    return this.summaries.find((session) => session.sessionId === sessionId)?.unread
      ? "unread"
      : undefined;
  }

  private markRead(sessionId = this.sessionId ?? CAKE_CHAT_SESSION_ID) {
    this.readSettledTurnRevisions.set(
      sessionId,
      this.props.sessionModel(sessionId).settledTurnRevision,
    );
    if (this.summaries.find((session) => session.sessionId === sessionId)?.unread)
      void this.setUnread(false, sessionId);
  }

  setUnread(unread: boolean, sessionId = CAKE_CHAT_SESSION_ID) {
    if (
      unread &&
      (this.activityFor(sessionId) === "running" || this.pendingSessions.isPending(sessionId))
    )
      return Promise.resolve();
    if (!unread)
      this.readSettledTurnRevisions.set(
        sessionId,
        this.props.sessionModel(sessionId).settledTurnRevision,
      );
    this.unreadUpdates = this.unreadUpdates.then(async () => {
      if (this.signal.aborted) return;
      try {
        await this.client.cakeChats.setUnread({ unread, sessionId }, { signal: this.signal });
      } catch (error) {
        if (!this.signal.aborted) this.reportError(error, "Chat could not update read status");
      }
    });
    return this.unreadUpdates;
  }

  async showContextMenu(x: number, y: number, sessionId = CAKE_CHAT_SESSION_ID) {
    const activity = this.activityFor(sessionId);
    try {
      const action = await this.client.electron.showSessionContextMenu(
        {
          sessionId,
          x,
          y,
          resolved: false,
          draft: false,
          permanent: true,
          unread:
            activity === "running" || this.pendingSessions.isPending(sessionId)
              ? undefined
              : activity === "unread" || activity === "error",
        },
        { signal: this.signal },
      );
      if (this.signal.aborted) return;
      if (action?.action === "mark-unread") await this.setUnread(true, sessionId);
      else if (action?.action === "mark-read") await this.setUnread(false, sessionId);
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error, "Chat could not open its actions");
    }
  }

  /** Explicit application startup. Repeated callers share one catalog-synchronized promise. */
  initialize() {
    if (!this.initialization)
      this.initialization = new Promise<void>((resolve) => {
        this.resolveInitialization = resolve;
      });
    if (this.props.catalog.loaded) void this.performInitialization();
    return this.initialization;
  }

  private async performInitialization() {
    if (this.initializing || this.hydrated || !this.props.catalog.loaded) return;
    this.initializing = true;
    try {
      this.reconcileAuthoritativeSessions();
      this.hydrated = true;
      const restoredSessionId = this.sessionId ?? CAKE_CHAT_SESSION_ID;
      const restored = restoredSessionId
        ? this.summaries.find(
            (summary) => summary.sessionId === restoredSessionId && !summary.resolved,
          )
        : undefined;
      if (restored) {
        if (this.pendingSessions.isPending(restored.sessionId))
          this.selectSession(restored.sessionId);
        else await this.open(restored.sessionId);
      } else {
        // A missing catalog entry must not redirect startup to another unsent conversation.
        const sessionId = CAKE_CHAT_SESSION_ID;
        if (this.summaries.some((summary) => summary.sessionId === sessionId))
          await this.open(sessionId);
        else {
          if (!this.pendingSessions.isPending(sessionId)) this.createPendingSession(sessionId);
          this.selectSession(sessionId);
        }
      }
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error, "Cake Chat could not load sessions");
    } finally {
      this.initializing = false;
      this.resolveInitialization?.();
      this.resolveInitialization = undefined;
    }
  }

  /** Reconcile an exact identity without waiting for the passive catalog stream. */
  async lookup(sessionId: string) {
    const session = await this.client.cakeChats.lookup({ sessionId }, { signal: this.signal });
    this.signal.throwIfAborted();
    applyCakeChatCatalogGroupUpdate(
      this.props.catalog,
      session.resolved ? { resolved: true, limit: 1 } : { resolved: false },
      {
        _tag: "Event",
        revision: 0,
        event: { _tag: "Upserted", session },
      },
    );
    return session;
  }

  async open(sessionId?: string) {
    if (!sessionId) return;
    const session = this.registry.load(sessionId);
    if (isProjectChatSessionId(sessionId)) {
      session.model.observationError = undefined;
      this.selectSession(sessionId);
      this.markRead(sessionId);
      // Selection demands observation; runtime acquisition must never gate navigation.
      return;
    }
    this.selectSession(sessionId);
    if (this.props.isSelected()) this.markRead();
    const revision = this.selectionRevision;
    try {
      await this.client.cakeChats.open(this.registry.target(sessionId), { signal: this.signal });
    } catch (error) {
      if (!this.signal.aborted && revision === this.selectionRevision) this.reportError(error);
    }
  }

  async openSession(sessionId: string) {
    if (isProjectChatSessionId(sessionId)) return this.open(sessionId);
    if (!this.hydrated) await this.initialize();
    this.markRead(sessionId);
    if (this.pendingSessions.isPending(sessionId) || sessionId === this.sessionId) {
      this.selectSession(sessionId);
      return;
    }
    return this.open(sessionId);
  }

  async activate(prompt?: string) {
    await this.initialize();
    if (this.signal.aborted) return;
    this.markRead();
    const existing = this.summaries.find(
      (item) =>
        item.sessionId === CAKE_CHAT_SESSION_ID && !this.pendingSessions.isPending(item.sessionId),
    );
    if (existing && !this.registry.find(CAKE_CHAT_SESSION_ID))
      await this.open(CAKE_CHAT_SESSION_ID);
    const session = this.registry.find(CAKE_CHAT_SESSION_ID) ?? this.prepareNewSession();
    this.selectSession(session.sessionId);
    if (prompt?.trim()) await session.conversationSessionStore.chatStore.submit(prompt);
  }

  reportError(error: unknown, context?: string) {
    if (this.activeSession)
      this.activeSession.conversationSessionStore.composerStore.reportError(error, context);
    else {
      const described = describeError(error, context);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  projectChat(projectPath: string) {
    return this.summaries.find((item) => item.projectPath === projectPath);
  }

  private prepareNewSession(sessionId: string = CAKE_CHAT_SESSION_ID, name = "Cake Chat") {
    const pendingSessionId = this.pendingSessions.firstUnstartedSessionId();
    if (pendingSessionId) return this.registry.find(pendingSessionId)!;
    const session = this.createPendingSession(sessionId, name);
    this.selectSession(sessionId);
    return session;
  }

  private createPendingSession(sessionId: string = CAKE_CHAT_SESSION_ID, name = "Cake Chat") {
    const session = this.registry.load(sessionId);
    this.pendingSessions.create(sessionId, name);
    return session;
  }

  private selectSession(sessionId: string) {
    this.selectionRevision += 1;
    const layout = this.layoutFor(sessionId);
    layout.showSession(sessionId);
  }

  private reconcileAuthoritativeSessions() {
    this.registry.reconcile(
      new Set(this.props.catalog.sessions.map((session) => session.sessionId)),
    );
  }

  constructor(props: CakeChatCollectionStore["props"]) {
    super(props);
    this.reaction(
      () => {
        const selected = this.props.isSelected() ? this.sessionId : undefined;
        return [
          selected,
          selected ? this.props.sessionModel(selected).settledTurnRevision : 0,
        ] as const;
      },
      ([selected], [previous]) => {
        if (previous)
          this.readSettledTurnRevisions.set(
            previous,
            this.props.sessionModel(previous).settledTurnRevision,
          );
        if (selected) this.markRead(selected);
      },
    );
    this.effect(() => {
      if (this.props.catalog.loaded) {
        this.reconcileAuthoritativeSessions();
        void this.performInitialization();
      }
    });
  }
}
