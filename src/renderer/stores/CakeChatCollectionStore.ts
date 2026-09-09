import { Store, child, createStore } from "r-state-tree";
import type { ChatConfiguration, ModelPreset } from "../../ipc/session-contract";
import { compareSessionSummariesForSidebar } from "../../utils/session-summary-order";
import { describeError } from "../lib/error-details";
import type { CakeChatCatalog } from "../models/CakeChatCatalog";
import type { Session } from "../models/Session";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { CakeChatManagementStore } from "./CakeChatManagementStore";
import {
  CakeChatPendingSessionsStore,
  type CakeChatSummaryProjection,
  type CakeControlTool,
} from "./CakeChatPendingSessionsStore";
import { CakeChatRegistryStore } from "./CakeChatRegistryStore";
import { ClientContext } from "./context/ClientContext";
import { SessionLayoutStore, type SessionSplitAxis } from "./SessionLayoutStore";
import { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface CakeChatCollectionStoreProps {
  catalog: CakeChatCatalog;
  sessionModel(sessionId: string): Session;
  tools(): ReadonlyArray<CakeControlTool>;
  modelPresets?(): readonly ModelPreset[];
  defaultConfiguration?(): ChatConfiguration | undefined;
  openModelPresetSettings?(): void;
  settings?(): AppearanceSettingsStore | undefined;
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
  get management(): CakeChatManagementStore {
    return createStore(CakeChatManagementStore, {
      pendingSessions: this.pendingSessions,
      target: (sessionId) => this.registry.target(sessionId),
      openSession: (sessionId) => this.open(sessionId),
      removeSession: (sessionId) => this.removeSession(sessionId),
      discardPendingSession: (sessionId) => this.discardPendingSession(sessionId),
      isSessionResolved: (sessionId) => this.isSessionResolved(sessionId),
      reportError: (error, context) => this.reportError(error, context),
    });
  }

  @child
  get registry(): CakeChatRegistryStore {
    return createStore(CakeChatRegistryStore, {
      sessionModel: this.props.sessionModel,
      tools: this.props.tools,
      pendingSessions: () => this.pendingSessions,
      management: () => this.management,
      operations: this.operations,
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
    const authoritative: CakeChatSummaryProjection[] = this.props.catalog.sessions.map(
      (session) => session,
    );
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
      const restored = this.sessionId
        ? this.summaries.find(
            (summary) => summary.sessionId === this.sessionId && !summary.resolved,
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
          const recent = this.summaries.find((summary) => !summary.resolved);
          if (recent) await this.open(recent.sessionId);
          else this.prepareNewSession();
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

  async open(sessionId?: string) {
    if (!sessionId) return;
    this.registry.load(sessionId);
    this.selectSession(sessionId);
    const revision = this.selectionRevision;
    try {
      await this.client.cakeChats.open(this.registry.target(sessionId), { signal: this.signal });
    } catch (error) {
      if (!this.signal.aborted && revision === this.selectionRevision) this.reportError(error);
    }
  }

  async openSession(sessionId: string) {
    if (!this.hydrated) await this.initialize();
    if (this.pendingSessions.isPending(sessionId) || sessionId === this.sessionId) {
      this.selectSession(sessionId);
      return;
    }
    return this.open(sessionId);
  }

  async startNewSession(prompt?: string) {
    await this.initialize();
    if (this.signal.aborted) return;
    const pendingSessionId = this.pendingSessions.firstUnstartedSessionId();
    const pending = pendingSessionId ? this.registry.find(pendingSessionId) : undefined;
    const session = pending ?? this.prepareNewSession();
    this.selectSession(session.sessionId);
    if (prompt?.trim()) await session.conversationSessionStore.chatStore.submit(prompt);
  }

  focusPane(paneId: string) {
    const sessionId = this.sessionLayoutStore.focusPane(paneId);
    if (sessionId) this.selectionRevision += 1;
    return sessionId;
  }

  splitFocused(axis: SessionSplitAxis) {
    if (!this.sessionLayoutStore.canSplit) return undefined;
    const session = this.createPendingSession();
    const paneId = this.sessionLayoutStore.splitFocused(session.sessionId, axis);
    if (!paneId) {
      this.removeSession(session.sessionId);
      return undefined;
    }
    this.selectionRevision += 1;
    session.conversationSessionStore.composerStore.draftStore.requestFocus();
    return { paneId, sessionId: session.sessionId };
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

  isSessionResolved(sessionId: string) {
    return this.summaries.find((session) => session.sessionId === sessionId)?.resolved ?? false;
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

  private prepareNewSession(sessionId: string = crypto.randomUUID(), name?: string) {
    const pendingSessionId = this.pendingSessions.firstUnstartedSessionId();
    if (pendingSessionId) return this.registry.find(pendingSessionId)!;
    const session = this.createPendingSession(sessionId, name);
    this.selectSession(sessionId);
    return session;
  }

  private createPendingSession(sessionId: string = crypto.randomUUID(), name?: string) {
    const session = this.registry.load(sessionId);
    this.pendingSessions.create(sessionId, name);
    return session;
  }

  private discardPendingSession(sessionId: string) {
    this.removeSession(sessionId);
    const focusedSessionId = this.sessionLayoutStore.focusedSessionId;
    if (focusedSessionId) this.selectSession(focusedSessionId);
    else {
      const next = this.registry.sessions[0];
      if (next) this.selectSession(next.sessionId);
      else this.prepareNewSession();
    }
  }

  private selectSession(sessionId: string) {
    this.selectionRevision += 1;
    if (this.sessionLayoutStore.layout) this.sessionLayoutStore.showSession(sessionId);
    else this.sessionLayoutStore.ensureSession(sessionId);
  }

  private removeSession(sessionId: string) {
    this.sessionLayoutStore.removeSessions([sessionId]);
    this.registry.remove(sessionId);
    this.pendingSessions.remove(sessionId);
    this.selectionRevision += 1;
  }

  private reconcileAuthoritativeSessions() {
    this.registry.reconcile(
      new Set(this.props.catalog.sessions.map((session) => session.sessionId)),
    );
  }

  constructor(props: CakeChatCollectionStore["props"]) {
    super(props);
    this.effect(() => {
      if (this.props.catalog.loaded) {
        this.reconcileAuthoritativeSessions();
        void this.performInitialization();
      }
    });
  }
}
