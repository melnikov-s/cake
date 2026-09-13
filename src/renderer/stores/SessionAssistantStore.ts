import { child, createStore, observable, Store } from "r-state-tree";
import type { CakeControlTool } from "../../domain/cake-chats/cake-chat-data";
import type { UiPart } from "../../ipc/session-contract";
import type { ReviewThread } from "../models/ReviewThread";
import { ChatStore } from "./ChatStore";
import { ClientContext } from "./context/ClientContext";

export interface SessionAssistantStoreProps {
  readonly sessionId: string;
  readonly workspacePath: string;
  staged(): boolean;
  thread(): ReviewThread | undefined;
  context(): ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  tools(): readonly CakeControlTool[];
}

/** Compact and full-chat presentations of one durable assistant Discussion Session. */
export class SessionAssistantStore extends Store<SessionAssistantStoreProps> {
  readonly quickParts: UiPart[] = observable([]);
  /** Optimistic projection used until the authoritative Discussion catalog catches up. */
  private readonly submittedParts: UiPart[] = observable([]);
  error: string | undefined;
  focusRequestRevision = 0;
  quickResponseRevision = 0;
  private activeRequest: AbortController | undefined;

  get client() {
    return ClientContext.consume(this)!;
  }

  get processing() {
    return Boolean(this.activeRequest);
  }

  get parts(): UiPart[] {
    const authoritative = this.props.thread()?.uiParts ?? [];
    const authoritativeMessages = authoritative.filter((part) => part.kind === "text").length;
    return authoritativeMessages >= this.submittedParts.length
      ? authoritative
      : this.submittedParts;
  }

  @child
  get chatStore(): ChatStore {
    return createStore(ChatStore, {
      id: () => `session-assistant:${this.props.sessionId}`,
      parts: () => this.parts,
      streaming: () => false,
      submitting: () => Boolean(this.activeRequest),
      configuration: () => undefined,
      commands: () => [],
      placeholder: () => "Ask the session assistant…",
      inputLabel: () => "Message session assistant",
      canSubmit: (draft) => Boolean(draft.trim()) && !this.activeRequest,
      submit: (draft) => this.submit(draft),
      abort: () => this.abort(),
      composerVisible: () => !this.processing,
      focusRequestRevision: () => this.focusRequestRevision,
    });
  }

  @child
  get quickChatStore(): ChatStore {
    return createStore(ChatStore, {
      id: () => `session-assistant-quick:${this.props.sessionId}`,
      parts: () => this.quickParts,
      streaming: () => false,
      submitting: () => Boolean(this.activeRequest),
      configuration: () => undefined,
      commands: () => [],
      placeholder: () => "Ask the session assistant…",
      inputLabel: () => "Ask session assistant",
      canSubmit: (draft) => Boolean(draft.trim()) && !this.activeRequest,
      submit: (draft) => this.submitQuick(draft),
      abort: () => this.abort(),
      composerVisible: () => !this.processing && this.quickParts.length === 0,
      focusRequestRevision: () => this.focusRequestRevision,
    });
  }

  beginQuickPrompt() {
    this.quickParts.splice(0);
    this.quickChatStore.setDraft("");
    this.quickResponseRevision = 0;
    this.error = undefined;
    this.requestFocus();
  }

  requestFocus() {
    this.focusRequestRevision += 1;
  }

  private async submit(prompt: string) {
    return this.runPrompt(prompt);
  }

  private async submitQuick(prompt: string) {
    return this.runPrompt(prompt, this.quickParts);
  }

  private async runPrompt(prompt: string, quickTarget?: UiPart[]) {
    const text = prompt.trim();
    if (!text || this.activeRequest) return false;
    this.error = undefined;
    const controller = new AbortController();
    this.activeRequest = controller;
    const signal = AbortSignal.any([this.signal, controller.signal]);
    try {
      const response = await this.client.workspaces.chatWithSessionAssistant(
        {
          sessionId: this.props.sessionId,
          workspacePath: this.props.workspacePath,
          prompt: text,
          staged: this.props.staged(),
          context: [...this.props.context()],
          tools: [...this.props.tools()],
        },
        { signal },
      );
      if (signal.aborted) return false;
      const assistantPart = {
        id: crypto.randomUUID(),
        kind: "text" as const,
        role: "assistant" as const,
        text: response,
        status: "complete" as const,
        renderAs: "markdown" as const,
      };
      this.submittedParts.push(
        {
          id: crypto.randomUUID(),
          kind: "text",
          role: "user",
          text,
          status: "complete",
        },
        assistantPart,
      );
      if (quickTarget) {
        quickTarget.push({ ...assistantPart, id: crypto.randomUUID() });
        this.quickResponseRevision += 1;
      }
      return true;
    } catch (error) {
      if (!signal.aborted) this.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (this.activeRequest === controller) this.activeRequest = undefined;
    }
  }

  private async abort() {
    this.activeRequest?.abort();
  }
}
