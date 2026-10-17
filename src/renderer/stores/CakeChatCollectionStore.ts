import { Store, child, createStore, observable } from "r-state-tree";
import type { SessionActivity } from "../lib/session-activity";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
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
import type { WorkflowCatalog } from "../models/WorkflowCatalog";
import type { SubagentCatalog } from "../models/SubagentCatalog";
import type { DiscussionCatalog } from "../models/DiscussionCatalog";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import {
  CakeChatPendingSessionsStore,
  type CakeChatSummaryProjection,
  type CakeControlTool,
} from "./CakeChatPendingSessionsStore";
import { CakeChatRegistryStore } from "./CakeChatRegistryStore";
import { ClientContext } from "./context/ClientContext";
import { SessionLayoutStore } from "./SessionLayoutStore";
import { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface CakeChatCollectionStoreProps {
  catalog: CakeChatCatalog;
  artifactModel: ArtifactCatalog;
  sessionModel(sessionId: string): Conversation;
  controlsModel(sessionId: string): CakeChatControls;
  subagentCatalog(sessionId: string): SubagentCatalog;
  workflowCatalog(sessionId: string): WorkflowCatalog;
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
  settings?(): AppearanceSettingsStore | undefined;
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
  private hydrationPaneId: string | undefined;
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
    return createStore(SessionLayoutStore, { allowSplit: false });
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
      sessionModel: this.props.sessionModel,
      artifactModel: this.props.artifactModel,
      controlsModel: this.props.controlsModel,
      subagentCatalog: this.props.subagentCatalog,
      workflowCatalog: this.props.workflowCatalog,
      discussionCatalog: this.props.discussionCatalog,
      discussionSessionModel: this.props.discussionSessionModel,
      tools: this.props.tools,
      pendingSessions: () => this.pendingSessions,
      operations: this.operations,
      isVisible: (sessionId) => this.sessionLayoutStore.hasSession(sessionId),
      modelPresets: this.props.modelPresets,
      openModelPresetSettings: this.props.openModelPresetSettings,
      settings: this.props.settings,
    });
  }

  get client() {
    return ClientContext.consume(this)!;
  }

  /** Cake Chat selection is the dedicated layout's focused session; no second persisted ID exists. */
  get sessionId() {
    return this.sessionLayoutStore.focusedSessionId;
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
    const model = this.props.sessionModel(sessionId);
    const subagents = this.props.subagentCatalog(sessionId);
    if (
      model.streaming ||
      model.activeTurnIds.length > 0 ||
      subagents.activities.some(
        (activity) =>
          !subagents.releasedHandleIds.includes(activity.handleId) &&
          (activity.status === "queued" || activity.status === "running"),
      )
    )
      return "running";
    if (
      !(this.props.isSelected() && this.sessionId === sessionId) &&
      model.settledTurnRevision > (this.readSettledTurnRevisions.get(sessionId) ?? 0)
    )
      return model.settledTurns.at(-1)?.outcome === "failed" ? "error" : "unread";
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
      // Hydration rebuilds one pane, reusing the visible pane's identity so a composer
      // already on screen (the drop-down focuses it at once) is not remounted mid-typing.
      const restoredSessionId = this.sessionId;
      this.hydrationPaneId = this.sessionLayoutStore.focusedPaneId;
      this.sessionLayoutStore.layout = undefined;
      this.sessionLayoutStore.focusedPaneId = undefined;
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
        const pendingSessionId = this.pendingSessions.firstUnstartedSessionId();
        if (pendingSessionId) this.selectSession(pendingSessionId);
        else {
          const recent = this.summaries.find(
            (summary) => summary.sessionId === CAKE_CHAT_SESSION_ID,
          );
          if (recent) await this.open(recent.sessionId);
          else this.prepareNewSession();
        }
      }
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error, "Cake Chat could not load sessions");
    } finally {
      this.hydrationPaneId = undefined;
      this.initializing = false;
      this.resolveInitialization?.();
      this.resolveInitialization = undefined;
    }
  }

  async open(sessionId?: string) {
    if (!sessionId) return;
    this.registry.load(sessionId);
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

  focusPane(paneId: string) {
    const sessionId = this.sessionLayoutStore.focusPane(paneId);
    if (sessionId) this.selectionRevision += 1;
    return sessionId;
  }

  closePane(paneId: string) {
    const result = this.sessionLayoutStore.closePane(paneId);
    if (!result) return undefined;
    this.selectionRevision += 1;
    for (const sessionId of result.removedSessionIds)
      if (this.pendingSessions.isPending(sessionId)) {
        this.registry.remove(sessionId);
        this.pendingSessions.remove(sessionId);
      }
    return result;
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
    if (this.sessionLayoutStore.layout) this.sessionLayoutStore.showSession(sessionId);
    else this.sessionLayoutStore.ensureSession(sessionId, this.hydrationPaneId);
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
