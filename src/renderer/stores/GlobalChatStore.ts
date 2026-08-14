import { Store, observable, untracked } from "r-state-tree";
import type { UiPart } from "../../ipc/session-contract";
import type { DesktopClientEvent } from "../desktop-client";

export interface GlobalChatPort {
  open(input: { operationId: string; tools: ReadonlyArray<{ name: string; description: string }> }): Promise<void>;
  prompt(input: { operationId: string; text: string }): Promise<void>;
  abort(operationId: string): Promise<void>;
  clear(input: { operationId: string; tools: ReadonlyArray<{ name: string; description: string }> }): Promise<void>;
}

export interface GlobalChatStoreProps {
  port: GlobalChatPort;
  tools(): ReadonlyArray<{ name: string; description: string }>;
}

/** Owns the singleton global-chat surface, its persistent Pi transcript, and turn policy. */
export class GlobalChatStore extends Store<GlobalChatStoreProps> {
  readonly parts: UiPart[] = observable([]);
  sessionId: string | undefined;
  draft = "";
  streaming = false;
  hydrated = false;
  error: string | undefined;
  private activeOperationId: string | undefined;
  private openPromise: Promise<void> | undefined;

  constructor(props: GlobalChatStore["props"]) {
    super(props);
    this.effect(() => {
      untracked(() => { void this.open(); });
    });
  }

  setDraft(value: string) { this.draft = value; }

  open() {
    if (this.openPromise) return this.openPromise;
    const operationId = crypto.randomUUID();
    this.activeOperationId = operationId;
    this.openPromise = this.props.port.open({ operationId, tools: this.toolCatalog() }).catch((error) => {
      if (!this.signal.aborted) this.fail(operationId, error);
    }).finally(() => { this.openPromise = undefined; });
    return this.openPromise;
  }

  async submit() {
    const text = this.draft.trim();
    if (!text) return;
    const operationId = crypto.randomUUID();
    this.activeOperationId = operationId;
    this.error = undefined;
    this.draft = "";
    this.parts.push({ id: `global-user-${operationId}`, kind: "text", role: "user", text, status: "complete" });
    try {
      await this.props.port.prompt({ operationId, text });
    } catch (error) {
      this.fail(operationId, error);
    }
  }

  async abort() {
    if (!this.streaming) return;
    const operationId = crypto.randomUUID();
    this.activeOperationId = operationId;
    try { await this.props.port.abort(operationId); }
    catch (error) { this.fail(operationId, error); }
  }

  async clear() {
    const operationId = crypto.randomUUID();
    this.activeOperationId = operationId;
    this.error = undefined;
    try { await this.props.port.clear({ operationId, tools: this.toolCatalog() }); }
    catch (error) { this.fail(operationId, error); }
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "global-chat-snapshot-received") {
      this.sessionId = event.sessionId;
      this.parts.splice(0, this.parts.length, ...event.parts);
      this.streaming = event.streaming;
      this.hydrated = true;
      return;
    }
    if (event.type === "global-chat-part-updated") {
      const index = this.parts.findIndex((part) => part.id === event.part.id);
      if (index < 0) this.parts.push(event.part);
      else this.parts.splice(index, 1, event.part);
      return;
    }
    if (event.type === "global-chat-part-removed") {
      const index = this.parts.findIndex((part) => part.id === event.partId);
      if (index >= 0) this.parts.splice(index, 1);
      return;
    }
    if (event.type === "global-chat-streaming-changed") {
      this.streaming = event.streaming;
      return;
    }
    if (event.type === "global-chat-operation-completed" && event.operationId === this.activeOperationId) {
      this.activeOperationId = undefined;
      return;
    }
    if (event.type === "global-chat-operation-failed" && event.operationId === this.activeOperationId) this.fail(event.operationId, event.message);
  }

  private toolCatalog() {
    return this.props.tools().map(({ name, description }) => ({ name, description }));
  }

  private fail(operationId: string, error: unknown) {
    if (operationId !== this.activeOperationId) return;
    this.activeOperationId = undefined;
    this.streaming = false;
    this.hydrated = true;
    this.error = error instanceof Error ? error.message : String(error);
  }
}
