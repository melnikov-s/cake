import { Store, child, createStore, observable, untracked } from "r-state-tree";
import type { DesktopClientEvent } from "../desktop-client";
import type { JsonObject } from "../../ipc/json-contract";
import type {
  ApplicationState,
  Attachment,
  SessionSnapshot,
  ThinkingLevel,
} from "../../ipc/session-contract";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { CakeChatSessionStore } from "./CakeChatSessionStore";
import { describeError } from "../error-details";

export interface GlobalChatPort {
  open(input: {
    operationId: string;
    tools: ReadonlyArray<{ name: string; description: string; parameters: JsonObject }>;
    newSession?: boolean;
    sessionId?: string;
    initialPrompt?: string;
  }): Promise<void>;
  prompt(input: {
    operationId: string;
    sessionId: string;
    text: string;
    attachments: Attachment[];
  }): Promise<void>;
  abort(input: { operationId: string; sessionId: string }): Promise<void>;
  compact(input: { operationId: string; sessionId: string; instructions?: string }): Promise<void>;
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
  resolveSession(sessionId: string, resolved: boolean): Promise<ApplicationState>;
}

export interface GlobalChatStoreProps {
  port: GlobalChatPort;
  tools(): ReadonlyArray<{ name: string; description: string; parameters: JsonObject }>;
  sessions(): SessionRegistryStore;
  operations: SessionOperationCoordinatorStore;
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

  constructor(props: GlobalChatStore["props"]) {
    super(props);
    this.effect(() => {
      untracked(() => {
        void this.open();
      });
    });
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
        sessions: this.props.sessions(),
        operations: this.props.operations,
      }),
    );
  }

  get activeSession() {
    return this.selectedSessionId ? this.findSession(this.selectedSessionId) : undefined;
  }

  findSession(sessionId: string) {
    return this.loadedSessions.find((session) => session.sessionId === sessionId);
  }

  open(sessionId?: string, newSession = false, initialPrompt?: string) {
    const operationId = this.props.operations.start("cake-chat-open");
    return this.port
      .open({ operationId, tools: this.props.tools(), sessionId, newSession, initialPrompt })
      .catch((error) => {
        this.props.operations.finish(operationId);
        this.reportError(error);
      });
  }

  startNewSession(prompt?: string) {
    return this.open(undefined, true, prompt);
  }

  applyApplicationState(state: ApplicationState) {
    this.resolvedSessionIds.splice(
      0,
      this.resolvedSessionIds.length,
      ...state.resolvedCakeChatSessionIds,
    );
    this.applyResolvedState();
  }

  async resolveSession(sessionId: string, resolved: boolean) {
    try {
      this.applyApplicationState(await this.port.resolveSession(sessionId, resolved));
    } catch (error) {
      this.reportError(error);
    }
  }

  async resolveSessions(sessionIds: readonly string[], resolved: boolean) {
    try {
      for (const sessionId of sessionIds)
        this.applyApplicationState(await this.port.resolveSession(sessionId, resolved));
      return sessionIds.length;
    } catch (error) {
      this.reportError(error);
      throw error;
    }
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
      this.props.sessions().upsert(event.snapshot);
      this.ensureTarget(event.snapshot.sessionId);
      this.applySummaries(event.snapshot);
      if (
        event.operationId &&
        this.props.operations.includes(event.operationId, "cake-chat-open")
      ) {
        this.selectedSessionId = event.snapshot.sessionId;
      } else if (!this.selectedSessionId) {
        this.selectedSessionId = event.snapshot.sessionId;
      }
      this.hydrated = true;
      return;
    }
    if (event.type === "global-chat-part-updated") {
      this.props.sessions().findModel(event.sessionId)?.upsertPart(event.part);
      return;
    }
    if (event.type === "global-chat-part-removed") {
      this.props.sessions().findModel(event.sessionId)?.removePart(event.partId);
      return;
    }
    if (event.type === "global-chat-streaming-changed") {
      this.props.sessions().findModel(event.sessionId)?.setStreaming(event.streaming);
      return;
    }
    if (event.type === "global-chat-operation-failed") {
      for (const session of this.loadedSessions)
        session.receiveOperationFailure(event.operationId, event.message);
      if (this.props.operations.includes(event.operationId, "cake-chat-open"))
        this.reportError(event.message);
      this.props.operations.finish(event.operationId);
      return;
    }
    if (event.type === "global-chat-operation-completed")
      this.props.operations.finish(event.operationId);
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
    next.sort((left, right) => right.modified.localeCompare(left.modified));
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
