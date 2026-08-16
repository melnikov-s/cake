import { Store, child, createStore, observable, untracked } from "r-state-tree";
import type { DesktopClientEvent } from "../desktop-client";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import { describeError } from "../error-details";
import type { JsonObject } from "../../ipc/json-contract";
import { ChatConfigurationStore } from "./ChatConfigurationStore";
import { ChatStore } from "./ChatStore";
import type { Attachment, ThinkingLevel, UiPart } from "../../ipc/session-contract";
import { pastedImageAttachments } from "../pasted-image-attachments";

export interface GlobalChatPort {
  open(input: { operationId: string; tools: ReadonlyArray<{ name: string; description: string; parameters: JsonObject }> }): Promise<void>;
  prompt(input: { operationId: string; text: string; attachments: Attachment[] }): Promise<void>;
  abort(operationId: string): Promise<void>;
  clear(input: { operationId: string; tools: ReadonlyArray<{ name: string; description: string; parameters: JsonObject }> }): Promise<void>;
}

export interface GlobalChatStoreProps {
  port: GlobalChatPort;
  tools(): ReadonlyArray<{ name: string; description: string; parameters: JsonObject }>;
  sessions(): SessionRegistryStore;
  setModel(operationId: string, provider: string, modelId: string): Promise<void>;
  setThinkingLevel(operationId: string, level: ThinkingLevel): Promise<void>;
}

/** Owns the singleton global-chat surface, its persistent Pi transcript, and turn policy. */
export class GlobalChatStore extends Store<GlobalChatStoreProps> {
  sessionId: string | undefined;
  hydrated = false;
  error: string | undefined;
  errorDetails: string | undefined;
  attachments: Attachment[] = observable([]);
  private readonly operations: Array<{ id: string; owner: string }> = observable([]);
  private openPromise: Promise<void> | undefined;

  constructor(props: GlobalChatStore["props"]) {
    super(props);
    this.effect(() => {
      untracked(() => { void this.open(); });
    });
  }

  get session() { return this.sessionId ? this.props.sessions().findModel(this.sessionId) : undefined; }
  get parts() { return this.session?.uiParts ?? []; }
  get streaming() { return this.session?.streaming ?? false; }
  get hasPendingPrompt() {
    return this.activeOperations.some((operationId) => this.parts.some((part) => part.id === `global-user-${operationId}`));
  }

  open() {
    if (this.openPromise) return this.openPromise;
    const operationId = this.start();
    this.openPromise = this.props.port.open({ operationId, tools: this.toolCatalog() }).catch((error) => {
      if (!this.signal.aborted) this.fail(operationId, error);
    }).finally(() => { this.openPromise = undefined; });
    return this.openPromise;
  }

  async submit(text: string) {
    text = text.trim();
    const attachments = this.attachments.slice();
    if (!text && attachments.length === 0) return;
    const operationId = this.start();
    const optimisticParts: UiPart[] = [
      ...(text ? [{ id: `global-user-${operationId}`, kind: "text" as const, role: "user" as const, text, status: "complete" as const }] : []),
      ...attachments.flatMap((attachment, index) => attachment.kind === "image" ? [{ id: `global-user-${operationId}-attachment-${index}`, kind: "attachment" as const, name: attachment.name, mediaType: attachment.mimeType, attachmentKind: "image" as const, data: attachment.data }] : [])
    ];
    for (const part of optimisticParts) this.session?.upsertPart(part);
    this.attachments.splice(0);
    try {
      await this.props.port.prompt({ operationId, text, attachments });
    } catch (error) {
      this.attachments.push(...attachments);
      this.fail(operationId, error);
    }
  }

  async addPastedImages(files: readonly File[]) {
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      const attachments = await pastedImageAttachments(files, 20 - this.attachments.length);
      if (!this.signal.aborted) this.attachments.push(...attachments);
    } catch (error) {
      this.reportError(error);
    }
  }

  removeAttachment(index: number) {
    this.attachments.splice(index, 1);
  }

  @child
  get configurationStore(): ChatConfigurationStore {
    return createStore(ChatConfigurationStore, {
      session: () => this.session,
      operations: this,
      operationOwner: "global-chat-configuration",
      setModel: (operationId, provider, modelId) => this.props.setModel(operationId, provider, modelId),
      setThinkingLevel: (operationId, level) => this.props.setThinkingLevel(operationId, level)
    });
  }

  @child
  get chatStore(): ChatStore {
    return createStore(ChatStore, {
      id: () => this.sessionId ?? "global-chat",
      parts: () => this.parts,
      streaming: () => this.streaming,
      submitting: () => this.hasPendingPrompt,
      configuration: () => this.configurationStore,
      commands: () => this.session?.commands ?? [],
      placeholder: () => "Ask Cake to find or control a task…",
      inputLabel: () => "Message global chat",
      canSubmit: (draft) => Boolean(draft.trim() || this.attachments.length > 0),
      submit: async (draft) => { await this.submit(draft); },
      abort: () => this.abort(),
      attachments: () => this.attachments,
      addPastedImages: (files) => this.addPastedImages(files),
      removeAttachment: (index) => this.removeAttachment(index),
      hideThinking: () => Boolean(this.session?.piSettings?.hideThinkingBlock),
      error: () => ({ message: this.configurationStore.error ?? this.error, details: this.configurationStore.errorDetails ?? this.errorDetails, title: "Global chat failed" })
    });
  }

  async abort() {
    if (!this.streaming) return;
    const operationId = this.start();
    try { await this.props.port.abort(operationId); }
    catch (error) { this.fail(operationId, error); }
  }

  async clear() {
    const operationId = this.start();
    try { await this.props.port.clear({ operationId, tools: this.toolCatalog() }); }
    catch (error) { this.fail(operationId, error); }
  }

  get activeOperations() { return this.active("global-chat"); }

  start(owner = "global-chat") {
    const operationId = crypto.randomUUID();
    this.operations.push({ id: operationId, owner });
    this.error = undefined;
    this.errorDetails = undefined;
    return operationId;
  }

  finish(operationId: string) {
    const index = this.operations.findIndex((operation) => operation.id === operationId);
    if (index >= 0) this.operations.splice(index, 1);
  }

  includes(operationId: string, owner?: string) { return this.operations.some((operation) => operation.id === operationId && (!owner || operation.owner === owner)); }
  active(owner?: string) { return this.operations.filter((operation) => !owner || operation.owner === owner).map((operation) => operation.id); }
  reset(owner?: string) {
    if (!owner) this.operations.splice(0);
    else for (let index = this.operations.length - 1; index >= 0; index -= 1) {
      if (this.operations[index]!.owner === owner) this.operations.splice(index, 1);
    }
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
      this.finish(event.operationId);
      return;
    }
    if (event.type === "global-chat-operation-failed" && this.activeOperations.includes(event.operationId)) this.fail(event.operationId, event.message);
  }

  private toolCatalog() {
    return this.props.tools();
  }

  private fail(operationId: string, error: unknown) {
    if (!this.activeOperations.includes(operationId)) return;
    this.finish(operationId);
    this.session?.setStreaming(false);
    this.hydrated = true;
    this.reportError(error);
  }
}
