import { Store, child, createStore, observable } from "r-state-tree";
import type { DesktopClientEvent } from "../desktop-client";
import type { JsonObject } from "../../ipc/json-contract";
import type {
  ApplicationState,
  Attachment,
  ChatConfiguration,
  ModelOption,
  ModelPreset,
  SessionPreview,
  SessionSnapshot,
  SessionSummary,
  ThinkingLevel,
} from "../../ipc/session-contract";
import { compareSessionSummariesForSidebar } from "../../utils/session-summary-order";
import { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { CakeChatSessionStore } from "./CakeChatSessionStore";
import { describeError } from "../error-details";

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

export interface GlobalChatPort {
  listSessions(): Promise<SessionSummary[]>;
  loadSession(sessionId: string): Promise<SessionPreview | undefined>;
  listModels(): Promise<ModelOption[]>;
  showComposerContextMenu(input: {
    selection: string;
    x: number;
    y: number;
  }): Promise<"reword" | "reword-with-prompt" | undefined>;
  rewordComposerSelection(input: { selection: string; prompt?: string }): Promise<string>;
  showSendContextMenu?(input: { x: number; y: number }): Promise<"create-draft" | undefined>;
  generateSessionTitle?(firstUserMessage: string): Promise<string | undefined>;
  open(input: {
    operationId: string;
    tools: ReadonlyArray<CakeControlTool>;
    sessionId?: string;
  }): Promise<void>;
  prompt(input: {
    operationId: string;
    sessionId: string;
    text: string;
    renderUserMessageAsMarkdown: boolean;
    attachments: Attachment[];
    newSession?: {
      tools: ReadonlyArray<CakeControlTool>;
      configuration?: ChatConfiguration;
      name?: string;
    };
  }): Promise<void>;
  editMessage?(input: {
    operationId: string;
    sessionId: string;
    entryId: string;
    text: string;
    attachments: Attachment[];
  }): Promise<void>;
  abort(input: { operationId: string; sessionId: string }): Promise<void>;
  compact(input: { operationId: string; sessionId: string; instructions?: string }): Promise<void>;
  handoff(input: {
    operationId: string;
    sessionId: string;
    entryId: string;
    prompt?: string;
    resolveSource?: boolean;
  }): Promise<void>;
  setConfiguration(input: {
    operationId: string;
    sessionId: string;
    configuration: ChatConfiguration;
  }): Promise<void>;
  setModel(input: {
    operationId: string;
    sessionId: string;
    provider: string;
    modelId: string;
  }): Promise<void>;
  setThinkingLevel(input: {
    operationId: string;
    sessionId: string;
    level: ThinkingLevel;
  }): Promise<void>;
  setFastMode(input: { operationId: string; sessionId: string; enabled: boolean }): Promise<void>;
  rename(input: { operationId: string; sessionId: string; name: string }): Promise<void>;
  resolveSession(sessionId: string, resolved: boolean): Promise<ApplicationState>;
  deleteSession(sessionId: string): Promise<ApplicationState>;
}

export interface GlobalChatStoreProps {
  port: GlobalChatPort;
  tools(): ReadonlyArray<CakeControlTool>;
  modelPresets?(): readonly ModelPreset[];
  defaultConfiguration?(): ChatConfiguration | undefined;
  openModelPresetSettings?(): void;
  settings?(): AppearanceSettingsStore | undefined;
  persist?(): void;
}

/** Owns the Cake Chat session collection, selection, and per-session Store instances. */
export class GlobalChatStore extends Store<GlobalChatStoreProps> {
  selectedSessionId: string | undefined;
  hydrated = false;
  error: string | undefined;
  errorDetails: string | undefined;
  readonly summaries: SessionSnapshot["sessions"] = observable([]);
  readonly targets: string[] = observable([]);
  readonly resolvedSessionIds: string[] = observable([]);
  private initialization: Promise<void> | undefined;
  private pendingSessionId: string | undefined;
  private pendingConfiguration: ChatConfiguration | undefined;
  private pendingName: string | undefined;
  private pendingDraftPrompt:
    | { text: string; attachments: Attachment[]; resolved: boolean }
    | undefined;
  private selectionOpenOperationId: string | undefined;
  private handoffOperationId: string | undefined;
  private resolutionQueue: Promise<void> = Promise.resolve();
  private readonly pendingPartsBySession = new Map<
    string,
    Map<string, SessionSnapshot["parts"][number] | null>
  >();
  private readonly pendingStreamingBySession = new Map<string, boolean>();

  @child
  get operations(): SessionOperationCoordinatorStore {
    return createStore(SessionOperationCoordinatorStore);
  }

  get port() {
    return this.props.port;
  }
  get sessionId() {
    return this.selectedSessionId;
  }

  @child
  get loadedSessions(): CakeChatSessionStore[] {
    return this.targets.map((sessionId) =>
      createStore(CakeChatSessionStore, {
        key: sessionId,
        sessionId,
        collection: this,
        operations: this.operations,
        modelPresets: () => this.props.modelPresets?.() ?? [],
        openModelPresetSettings: () => this.props.openModelPresetSettings?.(),
        settings: () => this.props.settings?.(),
        persist: () => this.props.persist?.(),
      }),
    );
  }

  get activeSession() {
    return this.selectedSessionId ? this.findSession(this.selectedSessionId) : undefined;
  }

  findSession(sessionId: string) {
    return this.loadedSessions.find((session) => session.sessionId === sessionId);
  }

  /** Explicit application startup. Repeated callers share the same initialization. */
  initialize() {
    if (!this.initialization) this.initialization = this.performInitialization();
    return this.initialization;
  }

  private async performInitialization() {
    try {
      const summaries = await this.port.listSessions();
      if (this.signal.aborted) return;
      const persistedPendingSessionId = this.pendingSessionId;
      if (
        persistedPendingSessionId &&
        summaries.some((summary) => summary.id === persistedPendingSessionId)
      )
        this.markSessionStarted(persistedPendingSessionId);
      this.replaceSummaries(summaries);
      this.hydrated = true;
      if (this.pendingSessionId) {
        this.selectedSessionId = this.pendingSessionId;
        return;
      }
      const recent = summaries.find((summary) => !summary.resolved);
      if (recent) await this.open(recent.id);
      else this.prepareNewSession();
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error, "Cake Chat could not load sessions");
    }
  }

  open(sessionId?: string) {
    const operationId = this.operations.start("cake-chat-open");
    this.selectionOpenOperationId = operationId;
    return this.port
      .open({
        operationId,
        tools: this.props.tools(),
        sessionId,
      })
      .catch((error) => {
        this.operations.finish(operationId);
        if (this.selectionOpenOperationId === operationId)
          this.selectionOpenOperationId = undefined;
        if (!this.signal.aborted) this.reportError(error);
      });
  }

  async startNewSession(prompt?: string) {
    await this.initialize();
    if (this.signal.aborted) return;
    const pending = this.pendingSessionId ? this.findSession(this.pendingSessionId) : undefined;
    const session = pending ?? this.prepareNewSession();
    // A startup open is accepted before its snapshot arrives. Once the user
    // explicitly chooses a new chat, that late snapshot must not steal selection.
    this.selectionOpenOperationId = undefined;
    this.selectedSessionId = session.sessionId;
    if (prompt?.trim()) await session.submit(prompt);
  }

  isPendingSession(sessionId: string) {
    return this.pendingSessionId === sessionId;
  }

  pendingSessionConfiguration(sessionId: string) {
    return this.isPendingSession(sessionId)
      ? (this.pendingConfiguration ?? this.props.defaultConfiguration?.())
      : undefined;
  }

  setPendingSessionConfiguration(sessionId: string, configuration: ChatConfiguration) {
    if (!this.isPendingSession(sessionId)) return;
    this.pendingConfiguration = configuration;
    this.props.persist?.();
  }

  isDraftSession(sessionId: string) {
    return this.isPendingSession(sessionId) && this.pendingDraftPrompt !== undefined;
  }

  draftSessionPrompt(sessionId: string) {
    return this.isDraftSession(sessionId) ? this.pendingDraftPrompt : undefined;
  }

  createDraftSession(sessionId: string, text: string, attachments: Attachment[]) {
    if (!this.isPendingSession(sessionId)) return false;
    this.pendingDraftPrompt = { text, attachments: attachments.slice(), resolved: false };
    this.updateSummary(sessionId, (summary) => ({
      ...summary,
      draft: true,
      modified: new Date().toISOString(),
    }));
    this.props.persist?.();
    return true;
  }

  updateDraftSession(sessionId: string, text: string, attachments: Attachment[]) {
    if (!this.isDraftSession(sessionId)) return false;
    this.pendingDraftPrompt = {
      text,
      attachments: attachments.slice(),
      resolved: this.pendingDraftPrompt?.resolved ?? false,
    };
    this.props.persist?.();
    return true;
  }

  activateDraftSession(sessionId: string) {
    if (!this.isDraftSession(sessionId)) return undefined;
    const prompt = this.pendingDraftPrompt;
    this.pendingDraftPrompt = undefined;
    this.updateSummary(sessionId, (summary) => ({ ...summary, draft: false, resolved: false }));
    this.props.persist?.();
    return prompt;
  }

  applyGeneratedDraftName(sessionId: string, name: string) {
    if (!this.isDraftSession(sessionId) || this.pendingName) return;
    this.pendingName = name;
    this.updateSummary(sessionId, (summary) => ({ ...summary, title: name }));
    this.props.persist?.();
  }

  newSessionRequest(sessionId: string) {
    if (!this.isPendingSession(sessionId)) return undefined;
    return {
      tools: this.props.tools(),
      configuration: this.pendingSessionConfiguration(sessionId),
      name: this.pendingName,
    };
  }

  markSessionStarted(sessionId: string) {
    if (!this.isPendingSession(sessionId)) return;
    this.pendingSessionId = undefined;
    this.pendingConfiguration = undefined;
    this.pendingName = undefined;
    this.pendingDraftPrompt = undefined;
    this.props.persist?.();
  }

  pendingSessionState() {
    if (!this.pendingSessionId) return undefined;
    return {
      sessionId: this.pendingSessionId,
      draft: this.findSession(this.pendingSessionId)?.chatStore.draft ?? "",
      configuration: this.pendingConfiguration,
      name: this.pendingName,
      draftSession: this.pendingDraftPrompt !== undefined,
      resolved: this.pendingDraftPrompt?.resolved ?? false,
      stagedPrompt: this.pendingDraftPrompt
        ? {
            text: this.pendingDraftPrompt.text,
            attachments: this.pendingDraftPrompt.attachments,
          }
        : undefined,
    };
  }

  restorePendingSession(input: {
    sessionId: string;
    draft: string;
    configuration?: ChatConfiguration;
    name?: string;
    draftSession?: boolean;
    resolved?: boolean;
    stagedPrompt?: { text: string; attachments: Attachment[] };
  }) {
    if (this.pendingSessionId && this.pendingSessionId !== input.sessionId) {
      const targetIndex = this.targets.indexOf(this.pendingSessionId);
      if (targetIndex >= 0) this.targets.splice(targetIndex, 1);
      const summaryIndex = this.summaries.findIndex(
        (summary) => summary.id === this.pendingSessionId,
      );
      if (summaryIndex >= 0) this.summaries.splice(summaryIndex, 1);
      this.pendingSessionId = undefined;
    }
    const session = this.prepareNewSession(input.sessionId, input.name);
    this.pendingConfiguration = input.configuration;
    this.pendingName = input.name;
    this.pendingDraftPrompt =
      input.draftSession && input.stagedPrompt
        ? { ...input.stagedPrompt, resolved: input.resolved ?? false }
        : undefined;
    if (this.pendingDraftPrompt)
      this.updateSummary(input.sessionId, (summary) => ({
        ...summary,
        draft: true,
        resolved: this.pendingDraftPrompt?.resolved ?? false,
      }));
    session.chatStore.setDraft(input.draft);
  }

  async handoff(sessionId: string, entryId: string, prompt?: string, resolveSource = false) {
    if (this.selectionOpenOperationId) return false;
    const operationId = this.operations.start("cake-chat-open");
    this.selectionOpenOperationId = operationId;
    this.handoffOperationId = operationId;
    try {
      await this.port.handoff({
        operationId,
        sessionId,
        entryId,
        prompt: prompt?.trim() || undefined,
        resolveSource,
      });
      return true;
    } catch (error) {
      this.operations.finish(operationId);
      if (this.selectionOpenOperationId === operationId) this.selectionOpenOperationId = undefined;
      if (this.handoffOperationId === operationId) this.handoffOperationId = undefined;
      if (!this.signal.aborted) this.reportError(error);
      return false;
    }
  }

  async renameSession(sessionId: string, name: string) {
    name = name.trim();
    if (!name) return false;
    if (this.isPendingSession(sessionId)) {
      this.pendingName = name;
      this.updateSummary(sessionId, (summary) => ({
        ...summary,
        title: name,
        modified: new Date().toISOString(),
      }));
      this.props.persist?.();
      return true;
    }
    const operationId = this.operations.start("cake-chat-rename");
    try {
      await this.port.rename({ operationId, sessionId, name });
      return true;
    } catch (error) {
      this.operations.finish(operationId);
      if (!this.signal.aborted) this.reportError(error, "Cake Chat could not rename the session");
      return false;
    }
  }

  applyApplicationState(state: ApplicationState) {
    this.resolvedSessionIds.splice(
      0,
      this.resolvedSessionIds.length,
      ...state.resolvedCakeChatSessionIds,
    );
    this.applyResolvedState();
  }

  /** Resolution mutations are queued so an older response cannot overwrite newer application state. */
  resolveSession(sessionId: string, resolved: boolean) {
    if (this.isDraftSession(sessionId) && this.pendingDraftPrompt) {
      this.pendingDraftPrompt = { ...this.pendingDraftPrompt, resolved };
      this.updateSummary(sessionId, (summary) => ({ ...summary, resolved }));
      this.props.persist?.();
      return Promise.resolve();
    }
    if (resolved && this.isPendingSession(sessionId)) {
      this.discardPendingSession(sessionId);
      return Promise.resolve();
    }
    return this.enqueueResolution([sessionId], resolved, false).then(() => undefined);
  }

  async deleteSession(sessionId: string) {
    if (!this.isSessionResolved(sessionId) || this.signal.aborted) return;
    try {
      await this.resolutionQueue;
      const state = await this.port.deleteSession(sessionId);
      if (this.signal.aborted) return;
      this.applyApplicationState(state);
      this.removeSession(sessionId);
      if (this.selectedSessionId === sessionId) this.selectedSessionId = undefined;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    }
  }

  isSessionResolved(sessionId: string) {
    return this.resolvedSessionIds.includes(sessionId);
  }

  resolveSessions(sessionIds: readonly string[], resolved: boolean) {
    const ids = [...sessionIds];
    const persistedIds = ids.filter((sessionId) => {
      if (this.isDraftSession(sessionId) && this.pendingDraftPrompt) {
        this.pendingDraftPrompt = { ...this.pendingDraftPrompt, resolved };
        this.updateSummary(sessionId, (summary) => ({ ...summary, resolved }));
        this.props.persist?.();
        return false;
      }
      if (!resolved || !this.isPendingSession(sessionId)) return true;
      this.discardPendingSession(sessionId);
      return false;
    });
    return this.enqueueResolution(persistedIds, resolved, true).then(() => ids.length);
  }

  private enqueueResolution(sessionIds: readonly string[], resolved: boolean, rethrow: boolean) {
    const run = async () => {
      try {
        for (const sessionId of sessionIds) {
          const state = await this.port.resolveSession(sessionId, resolved);
          if (this.signal.aborted) return;
          this.applyApplicationState(state);
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
    if (sessionId === this.pendingSessionId || sessionId === this.selectedSessionId) {
      this.selectedSessionId = sessionId;
      return;
    }
    if (this.isSessionResolved(sessionId)) {
      const preview = await this.port.loadSession(sessionId);
      if (!preview || this.signal.aborted) return;
      this.ensureTarget(sessionId);
      this.findSession(sessionId)?.applyPreview(preview);
      this.selectedSessionId = sessionId;
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

  receive(event: DesktopClientEvent) {
    if (event.type === "global-chat-snapshot-received") {
      this.ensureTarget(event.snapshot.sessionId);
      const session = this.findSession(event.snapshot.sessionId)!;
      this.markSessionStarted(event.snapshot.sessionId);
      session.applySnapshot(event.snapshot);
      this.applyPendingEvents(session);
      session.receive(event);
      this.applySummaries(event.snapshot);
      if (event.operationId && event.operationId === this.selectionOpenOperationId) {
        this.selectedSessionId = event.snapshot.sessionId;
        this.selectionOpenOperationId = undefined;
      } else if (!this.selectedSessionId) {
        this.selectedSessionId = event.snapshot.sessionId;
      }
      this.hydrated = true;
      return;
    }
    if (event.type === "global-chat-part-updated") {
      const session = this.findSession(event.sessionId);
      if (session) session.upsertPart(event.part);
      else this.pendingParts(event.sessionId).set(event.part.id, event.part);
      return;
    }
    if (event.type === "global-chat-part-removed") {
      const session = this.findSession(event.sessionId);
      if (session) session.removePart(event.partId);
      else this.pendingParts(event.sessionId).set(event.partId, null);
      return;
    }
    if (event.type === "global-chat-streaming-changed") {
      const session = this.findSession(event.sessionId);
      if (session) session.setStreaming(event.streaming);
      else this.pendingStreamingBySession.set(event.sessionId, event.streaming);
      return;
    }
    if (event.type === "global-chat-operation-failed") {
      for (const session of this.loadedSessions) {
        if (!this.sessionOwnsOperation(session, event.operationId)) continue;
        session.receive(event);
        session.receiveOperationFailure(event.operationId, event.message, event.details);
      }
      if (this.operations.includes(event.operationId, "cake-chat-rename"))
        this.reportError(event.message, "Cake Chat could not rename the session");
      if (event.operationId === this.handoffOperationId) {
        this.handoffOperationId = undefined;
        this.reportError(event.message, "Cake Chat could not continue the handed-off session");
      }
      if (event.operationId === this.selectionOpenOperationId) {
        this.selectionOpenOperationId = undefined;
        this.error = event.message;
        this.errorDetails = event.details ?? event.message;
      }
      this.operations.finish(event.operationId);
      return;
    }
    if (event.type === "global-chat-operation-completed") {
      for (const session of this.loadedSessions) {
        if (this.sessionOwnsOperation(session, event.operationId)) session.receive(event);
      }
      if (event.operationId === this.handoffOperationId) this.handoffOperationId = undefined;
      this.operations.finish(event.operationId);
    }
  }

  private sessionOwnsOperation(session: CakeChatSessionStore, operationId: string) {
    return (
      this.operations.includes(operationId, session.promptOwner) ||
      this.operations.includes(operationId, session.configurationOwner) ||
      this.operations.includes(operationId, `cake-chat-abort:${session.sessionId}`)
    );
  }

  private pendingParts(sessionId: string) {
    const parts =
      this.pendingPartsBySession.get(sessionId) ??
      new Map<string, SessionSnapshot["parts"][number] | null>();
    this.pendingPartsBySession.set(sessionId, parts);
    return parts;
  }

  private applyPendingEvents(session: CakeChatSessionStore) {
    const parts = this.pendingPartsBySession.get(session.sessionId);
    if (parts) {
      for (const [partId, part] of parts) {
        if (part) session.upsertPart(part);
        else session.removePart(partId);
      }
      this.pendingPartsBySession.delete(session.sessionId);
    }
    const streaming = this.pendingStreamingBySession.get(session.sessionId);
    if (streaming !== undefined) {
      session.setStreaming(streaming);
      this.pendingStreamingBySession.delete(session.sessionId);
    }
  }

  private ensureTarget(sessionId: string) {
    if (!this.targets.includes(sessionId)) this.targets.push(sessionId);
  }

  private prepareNewSession(sessionId: string = crypto.randomUUID(), name?: string) {
    if (this.pendingSessionId) return this.findSession(this.pendingSessionId)!;
    const now = new Date().toISOString();
    this.pendingSessionId = sessionId;
    this.pendingConfiguration = undefined;
    this.pendingName = name;
    this.ensureTarget(sessionId);
    this.summaries.unshift({
      id: sessionId,
      title: name ?? "New chat",
      created: now,
      modified: now,
      messageCount: 0,
      resolved: false,
    });
    this.selectedSessionId = sessionId;
    return this.findSession(sessionId)!;
  }

  private discardPendingSession(sessionId: string) {
    this.removeSession(sessionId);
    this.pendingSessionId = undefined;
    this.pendingConfiguration = undefined;
    this.pendingName = undefined;
    this.pendingDraftPrompt = undefined;
    if (this.selectedSessionId === sessionId) {
      const next = this.loadedSessions[0];
      if (next) this.selectedSessionId = next.sessionId;
      else this.prepareNewSession();
    }
  }

  private removeSession(sessionId: string) {
    const targetIndex = this.targets.indexOf(sessionId);
    if (targetIndex >= 0) this.targets.splice(targetIndex, 1);
    const summaryIndex = this.summaries.findIndex((summary) => summary.id === sessionId);
    if (summaryIndex >= 0) this.summaries.splice(summaryIndex, 1);
    this.pendingPartsBySession.delete(sessionId);
    this.pendingStreamingBySession.delete(sessionId);
    this.props.persist?.();
  }

  private replaceSummaries(summaries: readonly SessionSummary[]) {
    const resolvedIds = new Set(this.resolvedSessionIds);
    const pending = this.pendingSessionId
      ? this.summaries.find((summary) => summary.id === this.pendingSessionId)
      : undefined;
    const next = summaries.map((summary) => ({
      ...summary,
      resolved: resolvedIds.has(summary.id),
    }));
    if (pending && !next.some((summary) => summary.id === pending.id)) next.push(pending);
    next.sort(compareSessionSummariesForSidebar);
    this.summaries.splice(0, this.summaries.length, ...next);
  }

  private updateSummary(sessionId: string, update: (summary: SessionSummary) => SessionSummary) {
    const index = this.summaries.findIndex((summary) => summary.id === sessionId);
    const summary = this.summaries[index];
    if (index >= 0 && summary) this.summaries.splice(index, 1, update(summary));
  }

  private applySummaries(snapshot: SessionSnapshot) {
    const prior = new Map(this.summaries.map((summary) => [summary.id, summary]));
    const resolvedIds = new Set(this.resolvedSessionIds);
    const next = snapshot.sessions.map((summary) => ({
      ...summary,
      resolved: resolvedIds.has(summary.id),
    }));
    const listed = new Set(next.map((summary) => summary.id));
    for (const sessionId of this.targets) {
      if (listed.has(sessionId)) continue;
      const existing = prior.get(sessionId);
      const now = new Date().toISOString();
      next.push(
        existing
          ? { ...existing, resolved: resolvedIds.has(sessionId) }
          : {
              id: sessionId,
              title: "New chat",
              created: now,
              modified: now,
              messageCount: 0,
              resolved: resolvedIds.has(sessionId),
            },
      );
    }
    next.sort(compareSessionSummariesForSidebar);
    this.summaries.splice(0, this.summaries.length, ...next);
  }

  private applyResolvedState() {
    const resolvedIds = new Set(this.resolvedSessionIds);
    for (let index = 0; index < this.summaries.length; index += 1) {
      const summary = this.summaries[index]!;
      if (summary.draft) continue;
      const resolved = resolvedIds.has(summary.id);
      if (summary.resolved !== resolved) this.summaries.splice(index, 1, { ...summary, resolved });
    }
  }
}
