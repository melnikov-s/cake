import { Store, observable, untracked } from "r-state-tree";
import type { DesktopClientEvent } from "../desktop-client";
import type { SessionCacheStore } from "./SessionCacheStore";
import { describeError } from "../error-details";

export interface GlobalChatPort {
  open(input: { operationId: string; tools: ReadonlyArray<{ name: string; description: string }> }): Promise<void>;
  prompt(input: { operationId: string; text: string }): Promise<void>;
  abort(operationId: string): Promise<void>;
  clear(input: { operationId: string; tools: ReadonlyArray<{ name: string; description: string }> }): Promise<void>;
}

export interface GlobalChatStoreProps {
  port: GlobalChatPort;
  tools(): ReadonlyArray<{ name: string; description: string }>;
  sessions(): SessionCacheStore;
}

/** Owns the singleton global-chat surface, its persistent Pi transcript, and turn policy. */
export class GlobalChatStore extends Store<GlobalChatStoreProps> {
  sessionId: string | undefined;
  draft = "";
  hydrated = false;
  error: string | undefined;
  errorDetails: string | undefined;
  readonly activeOperations: string[] = observable([]);
  private openPromise: Promise<void> | undefined;

  constructor(props: GlobalChatStore["props"]) {
    super(props);
    this.effect(() => {
      untracked(() => { void this.open(); });
    });
  }

  setDraft(value: string) { this.draft = value; }

  get session() { return this.sessionId ? this.props.sessions().find(this.sessionId) : undefined; }
  get parts() { return this.session?.uiParts ?? []; }
  get streaming() { return this.session?.streaming ?? false; }

  open() {
    if (this.openPromise) return this.openPromise;
    const operationId = this.startOperation();
    this.openPromise = this.props.port.open({ operationId, tools: this.toolCatalog() }).catch((error) => {
      if (!this.signal.aborted) this.fail(operationId, error);
    }).finally(() => { this.openPromise = undefined; });
    return this.openPromise;
  }

  async submit() {
    const text = this.draft.trim();
    if (!text) return;
    const operationId = this.startOperation();
    this.draft = "";
    this.session?.upsertPart({ id: `global-user-${operationId}`, kind: "text", role: "user", text, status: "complete" });
    try {
      await this.props.port.prompt({ operationId, text });
    } catch (error) {
      this.fail(operationId, error);
    }
  }

  async abort() {
    if (!this.streaming) return;
    const operationId = this.startOperation();
    try { await this.props.port.abort(operationId); }
    catch (error) { this.fail(operationId, error); }
  }

  async clear() {
    const operationId = this.startOperation();
    try { await this.props.port.clear({ operationId, tools: this.toolCatalog() }); }
    catch (error) { this.fail(operationId, error); }
  }

  startOperation() {
    const operationId = crypto.randomUUID();
    this.activeOperations.push(operationId);
    this.error = undefined;
    this.errorDetails = undefined;
    return operationId;
  }

  finishOperation(operationId: string) {
    const index = this.activeOperations.indexOf(operationId);
    if (index >= 0) this.activeOperations.splice(index, 1);
  }

  reportError(error: unknown, context?: string) {
    const described = describeError(error, context);
    this.error = described.message;
    this.errorDetails = described.details;
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "global-chat-snapshot-received") {
      this.sessionId = event.snapshot.sessionId;
      this.props.sessions().upsert(event.snapshot);
      this.hydrated = true;
      return;
    }
    if (event.type === "global-chat-part-updated") {
      this.session?.upsertPart(event.part);
      return;
    }
    if (event.type === "global-chat-part-removed") {
      this.session?.removePart(event.partId);
      return;
    }
    if (event.type === "global-chat-streaming-changed") {
      this.session?.setStreaming(event.streaming);
      return;
    }
    if (event.type === "global-chat-operation-completed" && this.activeOperations.includes(event.operationId)) {
      this.finishOperation(event.operationId);
      return;
    }
    if (event.type === "global-chat-operation-failed" && this.activeOperations.includes(event.operationId)) this.fail(event.operationId, event.message);
  }

  private toolCatalog() {
    return this.props.tools().map(({ name, description }) => ({ name, description }));
  }

  private fail(operationId: string, error: unknown) {
    if (!this.activeOperations.includes(operationId)) return;
    this.finishOperation(operationId);
    this.session?.setStreaming(false);
    this.hydrated = true;
    this.reportError(error);
  }
}
