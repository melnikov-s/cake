import { Store, child, createStore, observable, snapshot } from "r-state-tree";
import { ClientContext } from "./context/ClientContext";
import type { JsonObject } from "../../ipc/json-contract";
import {
  SESSION_TITLE_MAX_LENGTH,
  type Attachment,
  type ChatConfiguration,
  type ModelPreset,
} from "../../ipc/session-contract";
import type { CakeChatSummary, CakeChatTarget } from "../../domain/cake-chat-data";
import { compareSessionSummariesForSidebar } from "../../utils/session-summary-order";
import { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { SessionLayoutStore, type SessionSplitAxis } from "./SessionLayoutStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { CakeChatSessionStore } from "./CakeChatSessionStore";
import { describeError } from "../error-details";
import type { CakeChatCatalog } from "../models/CakeChatCatalog";
import type { Session } from "../models/Session";

type CakeChatSummaryProjection = CakeChatSummary & { draft?: boolean };

interface CakeControlTool {
  command: string;
  topic: string;
  summary: string;
  guidance?: readonly string[];
  parameters: JsonObject;
  examples?: readonly { input?: JsonObject; description?: string }[];
  result?: string;
  limitations?: readonly string[];
}

interface NewCakeChatSessionRequest {
  tools: ReadonlyArray<CakeControlTool>;
  configuration?: ChatConfiguration;
  name?: string;
}

interface PendingCakeChatSession {
  sessionId: string;
  started: boolean;
  configuration?: ChatConfiguration;
  name?: string;
  draftPrompt?: { text: string; attachments: Attachment[]; resolved: boolean };
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
}

export interface CakeChatCollectionStoreProps {
  catalog: CakeChatCatalog;
  sessionModel(sessionId: string): Session;
  tools(): ReadonlyArray<CakeControlTool>;
  modelPresets?(): readonly ModelPreset[];
  defaultConfiguration?(): ChatConfiguration | undefined;
  openModelPresetSettings?(): void;
  settings?(): AppearanceSettingsStore | undefined;
}

/** Owns the Cake Chat session collection, selection, and per-session Store instances. */
export class CakeChatCollectionStore extends Store<CakeChatCollectionStoreProps> {
  @snapshot selectedSessionId: string | undefined;
  hydrated = false;
  error: string | undefined;
  errorDetails: string | undefined;
  @snapshot readonly targets: string[] = observable([]);
  private initialization: Promise<void> | undefined;
  private resolveInitialization: (() => void) | undefined;
  private initializing = false;
  @snapshot private readonly pendingSessions: PendingCakeChatSession[] = observable([]);
  private resolutionQueue: Promise<void> = Promise.resolve();
  private selectionRevision = 0;

  @child
  get operations(): SessionOperationCoordinatorStore {
    return createStore(SessionOperationCoordinatorStore);
  }

  @child
  get sessionLayoutStore(): SessionLayoutStore {
    return createStore(SessionLayoutStore);
  }

  get client() {
    return ClientContext.consume(this)!;
  }
  get sessionId() {
    return this.selectedSessionId;
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
      ...this.pendingSessions
        .filter((session) => !authoritativeIds.has(session.sessionId))
        .map((session) => this.pendingSummary(session)),
    );
    return authoritative.sort(compareSessionSummariesForSidebar);
  }
  @child
  get loadedSessions(): CakeChatSessionStore[] {
    return this.targets.map((sessionId) =>
      createStore(CakeChatSessionStore, {
        key: sessionId,
        sessionId,
        model: this.props.sessionModel(sessionId),
        collection: this,
        operations: this.operations,
        modelPresets: () => this.props.modelPresets?.() ?? [],
        openModelPresetSettings: () => this.props.openModelPresetSettings?.(),
        settings: () => this.props.settings?.(),
      }),
    );
  }

  get activeSession() {
    return this.selectedSessionId ? this.findSession(this.selectedSessionId) : undefined;
  }

  /** Loaded Cake Chat targets whose transcript projections should remain synchronized. */
  get observationTargets(): ReadonlyArray<CakeChatTarget> {
    return this.loadedSessions
      .filter((session) => !this.isPendingSession(session.sessionId))
      .map((session) => this.target(session.sessionId));
  }

  findSession(sessionId: string) {
    return this.loadedSessions.find((session) => session.sessionId === sessionId);
  }

  target(sessionId: string) {
    return { sessionId, tools: this.props.tools() };
  }

  /** Explicit application startup. Repeated callers wait for the synchronized catalog. */
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
      const restored = this.selectedSessionId
        ? this.summaries.find(
            (summary) => summary.sessionId === this.selectedSessionId && !summary.resolved,
          )
        : undefined;
      if (restored) {
        if (this.isPendingSession(restored.sessionId)) this.selectSession(restored.sessionId);
        else await this.open(restored.sessionId);
      } else {
        const pending = this.pendingSessions.find((session) => !session.started);
        if (pending) this.selectSession(pending.sessionId);
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
    if (!this.targets.includes(sessionId)) this.targets.push(sessionId);
    this.selectSession(sessionId);
    const revision = this.selectionRevision;
    try {
      await this.client.cakeChats.open(this.target(sessionId), { signal: this.signal });
    } catch (error) {
      if (!this.signal.aborted && revision === this.selectionRevision) this.reportError(error);
    }
  }

  async startNewSession(prompt?: string) {
    await this.initialize();
    if (this.signal.aborted) return;
    const pendingSession = this.pendingSessions.find((session) => !session.started);
    const pending = pendingSession ? this.findSession(pendingSession.sessionId) : undefined;
    const session = pending ?? this.prepareNewSession();
    this.selectSession(session.sessionId);
    if (prompt?.trim()) await session.chatStore.submit(prompt);
  }

  focusPane(paneId: string) {
    const sessionId = this.sessionLayoutStore.focusPane(paneId);
    if (sessionId) this.selectSession(sessionId);
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
    this.selectSession(session.sessionId);
    session.requestFocus();
    return { paneId, sessionId: session.sessionId };
  }

  closePane(paneId: string) {
    const result = this.sessionLayoutStore.closePane(paneId);
    if (!result) return undefined;
    for (const sessionId of result.removedSessionIds)
      if (this.isPendingSession(sessionId)) this.removeSession(sessionId);
    if (result.focusedSessionId) this.selectSession(result.focusedSessionId);
    return result;
  }

  isPendingSession(sessionId: string) {
    return this.pendingSessionFor(sessionId)?.started === false;
  }

  pendingSessionConfiguration(sessionId: string) {
    return this.isPendingSession(sessionId)
      ? (this.pendingSessionFor(sessionId)?.configuration ?? this.props.defaultConfiguration?.())
      : undefined;
  }

  setPendingSessionConfiguration(sessionId: string, configuration: ChatConfiguration) {
    if (!this.isPendingSession(sessionId)) return;
    this.updatePending(sessionId, (pending) => ({ ...pending, configuration }));
  }

  isDraftSession(sessionId: string) {
    return (
      this.isPendingSession(sessionId) &&
      this.pendingSessionFor(sessionId)?.draftPrompt !== undefined
    );
  }

  draftSessionPrompt(sessionId: string) {
    return this.isDraftSession(sessionId)
      ? this.pendingSessionFor(sessionId)?.draftPrompt
      : undefined;
  }

  createDraftSession(sessionId: string, text: string, attachments: Attachment[]) {
    if (!this.isPendingSession(sessionId)) return false;
    this.updatePending(sessionId, (pending) => ({
      ...pending,
      draftPrompt: { text, attachments: attachments.slice(), resolved: false },
      modifiedAt: new Date().toISOString(),
    }));
    return true;
  }

  updateDraftSession(sessionId: string, text: string, attachments: Attachment[]) {
    if (!this.isDraftSession(sessionId)) return false;
    this.updatePending(sessionId, (pending) => ({
      ...pending,
      draftPrompt: {
        text,
        attachments: attachments.slice(),
        resolved: pending.draftPrompt?.resolved ?? false,
      },
      modifiedAt: new Date().toISOString(),
    }));
    return true;
  }

  activateDraftSession(sessionId: string) {
    if (!this.isDraftSession(sessionId)) return undefined;
    const prompt = this.pendingSessionFor(sessionId)?.draftPrompt;
    this.updatePending(sessionId, (pending) => ({
      ...pending,
      draftPrompt: undefined,
      modifiedAt: new Date().toISOString(),
    }));
    return prompt;
  }

  applyGeneratedDraftName(sessionId: string, name: string) {
    if (!this.isDraftSession(sessionId) || this.pendingSessionFor(sessionId)?.name) return;
    this.updatePending(sessionId, (pending) => ({
      ...pending,
      name: name.trim().slice(0, SESSION_TITLE_MAX_LENGTH),
      modifiedAt: new Date().toISOString(),
    }));
  }

  newSessionRequest(sessionId: string) {
    if (!this.isPendingSession(sessionId)) return undefined;
    const request: NewCakeChatSessionRequest = { tools: this.props.tools() };
    const configuration = this.pendingSessionConfiguration(sessionId);
    if (configuration !== undefined) request.configuration = configuration;
    const pending = this.pendingSessionFor(sessionId);
    if (pending?.name !== undefined) request.name = pending.name;
    return request;
  }

  markSessionStarted(sessionId: string) {
    if (!this.isPendingSession(sessionId)) return;
    this.updatePending(sessionId, (pending) => ({
      ...pending,
      started: true,
      configuration: undefined,
      draftPrompt: undefined,
      modifiedAt: new Date().toISOString(),
      messageCount: Math.max(1, pending.messageCount),
    }));
  }

  async handoff(sessionId: string, entryId: string, prompt?: string, resolveSource = false) {
    try {
      const result = await this.client.cakeChats.handoff(
        {
          ...this.target(sessionId),
          entryId,
          prompt: prompt?.trim() || undefined,
          resolveSource,
        },
        { signal: this.signal },
      );
      if (this.signal.aborted) return false;
      await this.open(result.sessionId);
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return false;
    }
  }

  async renameSession(sessionId: string, name: string) {
    name = name.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
    if (!name) return false;
    if (this.isPendingSession(sessionId)) {
      this.updatePending(sessionId, (pending) => ({
        ...pending,
        name,
        modifiedAt: new Date().toISOString(),
      }));
      return true;
    }
    try {
      await this.client.cakeChats.rename(
        { ...this.target(sessionId), name },
        { signal: this.signal },
      );
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error, "Cake Chat could not rename the session");
      return false;
    }
  }

  /** Resolution commands are queued; the catalog stream remains the only projection writer. */
  async resolveSession(sessionId: string, resolved: boolean) {
    if (this.signal.aborted) return;
    if (this.isDraftSession(sessionId)) {
      this.updatePending(sessionId, (pending) => ({
        ...pending,
        draftPrompt: pending.draftPrompt ? { ...pending.draftPrompt, resolved } : undefined,
        modifiedAt: new Date().toISOString(),
      }));
      return;
    }
    if (resolved && this.isPendingSession(sessionId)) {
      this.discardPendingSession(sessionId);
      return;
    }
    await this.enqueueResolution([sessionId], resolved, false);
  }

  async deleteSession(sessionId: string) {
    if (!this.isSessionResolved(sessionId) || this.signal.aborted) return;
    try {
      if (this.isDraftSession(sessionId)) {
        this.removeSession(sessionId);
        if (this.selectedSessionId === sessionId) this.selectSession(undefined);
        return;
      }
      await this.resolutionQueue;
      await this.client.cakeChats.deleteResolved(this.target(sessionId), {
        signal: this.signal,
      });
      if (this.signal.aborted) return;
      this.removeSession(sessionId);
      if (this.selectedSessionId === sessionId) this.selectSession(undefined);
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    }
  }

  isSessionResolved(sessionId: string) {
    return this.summaries.find((session) => session.sessionId === sessionId)?.resolved ?? false;
  }

  async resolveSessions(sessionIds: readonly string[], resolved: boolean) {
    const ids = [...sessionIds];
    if (this.signal.aborted) return 0;
    const persistedIds = ids.filter((sessionId) => {
      if (this.isDraftSession(sessionId)) {
        this.updatePending(sessionId, (pending) => ({
          ...pending,
          draftPrompt: pending.draftPrompt ? { ...pending.draftPrompt, resolved } : undefined,
          modifiedAt: new Date().toISOString(),
        }));
        return false;
      }
      if (!resolved || !this.isPendingSession(sessionId)) return true;
      this.discardPendingSession(sessionId);
      return false;
    });
    await this.enqueueResolution(persistedIds, resolved, true);
    return ids.length;
  }

  private enqueueResolution(sessionIds: readonly string[], resolved: boolean, rethrow: boolean) {
    const run = async () => {
      try {
        for (const sessionId of sessionIds) {
          const target = this.target(sessionId);
          if (resolved) await this.client.cakeChats.resolve(target, { signal: this.signal });
          else await this.client.cakeChats.restore(target, { signal: this.signal });
          if (this.signal.aborted) return;
        }
      } catch (error) {
        if (!this.signal.aborted) this.reportError(error);
        if (rethrow) throw error;
      }
    };
    const result = this.resolutionQueue.then(run, run);
    this.resolutionQueue = result.catch(() => undefined);
    return result;
  }

  async openSession(sessionId: string) {
    if (!this.hydrated) await this.initialize();
    if (this.isPendingSession(sessionId) || sessionId === this.selectedSessionId) {
      this.selectSession(sessionId);
      return;
    }
    return this.open(sessionId);
  }

  reportError(error: unknown, context?: string) {
    if (this.activeSession) this.activeSession.reportError(error, context);
    else {
      const described = describeError(error, context);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  private prepareNewSession(sessionId: string = crypto.randomUUID(), name?: string) {
    const existing = this.pendingSessions.find((session) => !session.started);
    if (existing) return this.findSession(existing.sessionId)!;
    const session = this.createPendingSession(sessionId, name);
    this.selectSession(sessionId);
    return session;
  }

  private createPendingSession(sessionId: string = crypto.randomUUID(), name?: string) {
    const now = new Date().toISOString();
    this.targets.push(sessionId);
    this.pendingSessions.push({
      sessionId,
      started: false,
      name,
      createdAt: now,
      modifiedAt: now,
      messageCount: 0,
    });
    return this.findSession(sessionId)!;
  }

  private discardPendingSession(sessionId: string) {
    this.removeSession(sessionId);
    if (this.selectedSessionId === sessionId) {
      const next = this.loadedSessions[0];
      if (next) this.selectSession(next.sessionId);
      else this.prepareNewSession();
    }
  }

  private selectSession(sessionId: string | undefined) {
    this.selectionRevision += 1;
    this.selectedSessionId = sessionId;
    if (sessionId) {
      if (this.sessionLayoutStore.layout) this.sessionLayoutStore.showSession(sessionId);
      else this.sessionLayoutStore.ensureSession(sessionId);
    }
  }

  private removeSession(sessionId: string) {
    this.sessionLayoutStore.removeSessions([sessionId]);
    const targetIndex = this.targets.indexOf(sessionId);
    if (targetIndex >= 0) this.targets.splice(targetIndex, 1);
    const pendingIndex = this.pendingSessions.findIndex(
      (pending) => pending.sessionId === sessionId,
    );
    if (pendingIndex >= 0) this.pendingSessions.splice(pendingIndex, 1);
  }

  private pendingSummary(pending: PendingCakeChatSession): CakeChatSummaryProjection {
    return {
      sessionId: pending.sessionId,
      title: pending.name?.slice(0, SESSION_TITLE_MAX_LENGTH) ?? "New chat",
      createdAt: pending.createdAt,
      modifiedAt: pending.modifiedAt,
      messageCount: pending.messageCount,
      resolved: pending.draftPrompt?.resolved ?? false,
      draft: pending.draftPrompt !== undefined,
    };
  }

  private pendingSessionFor(sessionId: string) {
    return this.pendingSessions.find((pending) => pending.sessionId === sessionId);
  }

  private updatePending(
    sessionId: string,
    update: (pending: PendingCakeChatSession) => PendingCakeChatSession,
  ) {
    const index = this.pendingSessions.findIndex((pending) => pending.sessionId === sessionId);
    if (index >= 0) this.pendingSessions.splice(index, 1, update(this.pendingSessions[index]!));
  }

  private reconcileAuthoritativeSessions() {
    const authoritative = new Set(this.props.catalog.sessions.map((session) => session.sessionId));
    for (let index = this.pendingSessions.length - 1; index >= 0; index -= 1)
      if (authoritative.has(this.pendingSessions[index]!.sessionId))
        this.pendingSessions.splice(index, 1);
  }

  private removePendingSession(sessionId: string) {
    const index = this.pendingSessions.findIndex((pending) => pending.sessionId === sessionId);
    if (index >= 0) this.pendingSessions.splice(index, 1);
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
