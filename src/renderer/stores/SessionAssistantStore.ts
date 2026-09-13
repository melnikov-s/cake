import { child, createStore, observable, Store } from "r-state-tree";
import type { CakeControlTool } from "../../domain/cake-chats/cake-chat-data";
import type { UiPart } from "../../ipc/session-contract";
import { ChatStore } from "./ChatStore";
import { ClientContext } from "./context/ClientContext";

export interface SessionAssistantContextMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface SessionAssistantStoreProps {
  readonly sessionId: string;
  readonly workspacePath: string;
  context(): readonly SessionAssistantContextMessage[];
  tools(): readonly CakeControlTool[];
}

/** Window-local, non-persistent utility assistant for one Project Session. */
export class SessionAssistantStore extends Store<SessionAssistantStoreProps> {
  readonly parts: UiPart[] = observable([]);
  readonly quickParts: UiPart[] = observable([]);
  error: string | undefined;
  focusRequestRevision = 0;
  quickResponseRevision = 0;
  private activeRequest: AbortController | undefined;

  get client() {
    return ClientContext.consume(this)!;
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
      composerVisible: () => true,
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
      composerVisible: () => this.quickParts.length === 0,
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

  private history(): SessionAssistantContextMessage[] {
    return this.parts.flatMap((part) =>
      part.kind === "text" ? [{ role: part.role, text: part.text }] : [],
    );
  }

  private async submit(prompt: string) {
    return this.runPrompt(prompt, this.parts, true);
  }

  private async submitQuick(prompt: string) {
    return this.runPrompt(prompt, this.quickParts, false);
  }

  private async runPrompt(prompt: string, target: UiPart[], showPrompt: boolean) {
    const text = prompt.trim();
    if (!text || this.activeRequest) return false;
    const history = this.history();
    this.error = undefined;
    if (showPrompt)
      target.push({
        id: crypto.randomUUID(),
        kind: "text",
        role: "user",
        text,
        status: "complete",
      });
    const controller = new AbortController();
    this.activeRequest = controller;
    const signal = AbortSignal.any([this.signal, controller.signal]);
    try {
      const response = await this.client.workspaces.chatWithSessionAssistant(
        {
          sessionId: this.props.sessionId,
          workspacePath: this.props.workspacePath,
          prompt: text,
          context: [...this.props.context()],
          history,
          tools: [...this.props.tools()],
        },
        { signal },
      );
      if (signal.aborted) return false;
      target.push({
        id: crypto.randomUUID(),
        kind: "text",
        role: "assistant",
        text: response,
        status: "complete",
        renderAs: "markdown",
      });
      if (!showPrompt) this.quickResponseRevision += 1;
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
