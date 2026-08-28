import { Store, child, createStore, observable } from "r-state-tree";
import type { DesktopClientEvent } from "../desktop-client";
import type { JsonObject } from "../../ipc/json-contract";
import type {
  ApplicationState,
  Attachment,
  ChatConfiguration,
  ModelPreset,
  SessionSnapshot,
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
  open(input: {
    operationId: string;
    tools: ReadonlyArray<CakeControlTool>;
    newSession?: boolean;
    sessionId?: string;
    initialPrompt?: string;
    configuration?: ChatConfiguration;
  }): Promise<void>;
  prompt(input: {
    operationId: string;
    sessionId: string;
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
    if (!this.initialization) this.initialization = this.open();
    return this.initialization;
  }

  open(sessionId?: string, newSession = false, initialPrompt?: string) {
    const operationId = this.operations.start("cake-chat-open");
    this.selectionOpenOperationId = operationId;
    return this.port
      .open({
        operationId,
        tools: this.props.tools(),
        sessionId,
        newSession,
        initialPrompt,
        configuration: newSession ? this.props.defaultConfiguration?.() : undefined,
      })
      .catch((error) => {
        this.operations.finish(operationId);
        if (this.selectionOpenOperationId === operationId)
          this.selectionOpenOperationId = undefined;
        if (!this.signal.aborted) this.reportError(error);
      });
  }

  startNewSession(prompt?: string) {
    return this.open(undefined, true, prompt);
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
    return this.enqueueResolution([sessionId], resolved, false).then(() => undefined);
  }

  resolveSessions(sessionIds: readonly string[], resolved: boolean) {
    const ids = [...sessionIds];
    return this.enqueueResolution(ids, resolved, true).then(() => ids.length);
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

  openSession(sessionId: string) {
    if (sessionId === this.selectedSessionId) return Promise.resolve();
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
      const resolved = resolvedIds.has(summary.id);
      if (summary.resolved !== resolved) this.summaries.splice(index, 1, { ...summary, resolved });
    }
  }
}
