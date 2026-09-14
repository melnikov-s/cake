import { child, createStore, effect as reactiveEffect, observable, Store } from "r-state-tree";
import type { CakeControlTool } from "../../domain/cake-chats/cake-chat-data";
import type { Annotation, UiPart } from "../../ipc/session-contract";
import type { ReviewThread } from "../models/ReviewThread";
import { describeError } from "../lib/error-details";
import { ChatStore } from "./ChatStore";
import type { DiscussionSessionStore } from "./DiscussionSessionStore";
import { ClientContext } from "./context/ClientContext";

export interface SessionAssistantStoreProps {
  readonly sessionId: string;
  readonly workspacePath: string;
  staged(): boolean;
  /** The parent's messages while it is still a staged chat without a transcript. */
  stagedMessages(): ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  thread(): ReviewThread | undefined;
  tools(): readonly CakeControlTool[];
  /** The assistant thread's shared conversation Store once its sidecar is live. */
  discussionSession(threadId: string): DiscussionSessionStore | undefined;
}

/**
 * Compact and full-chat presentations of one Project Session's assistant. The
 * assistant is an ordinary Discussion Session on the utility model; this Store
 * owns only the avatar bubble's turn-at-a-time presentation on top of it.
 */
export class SessionAssistantStore extends Store<SessionAssistantStoreProps> {
  /** The answer bubble: the assistant's reply to the last quick prompt. */
  readonly quickParts: UiPart[] = observable([]);
  error: string | undefined;
  focusRequestRevision = 0;
  quickResponseRevision = 0;
  composerSelection: string | undefined;
  private ensuring = false;
  private quickTurnPending = false;
  private ensureRequest: AbortController | undefined;

  get client() {
    return ClientContext.consume(this)!;
  }

  /** The shared side-chat conversation, once the assistant's sidecar is live. */
  get discussion() {
    const thread = this.props.thread();
    return thread ? this.props.discussionSession(thread.id) : undefined;
  }

  get processing() {
    return this.ensuring || this.quickTurnPending;
  }

  /** The full chat is the assistant's side chat, exactly as any other side chat. */
  get chatStore(): ChatStore {
    return this.discussion?.chatStore ?? this.bootstrapChatStore;
  }

  /** Composer for the first message, before the assistant's sidecar exists. */
  @child
  get bootstrapChatStore(): ChatStore {
    return createStore(ChatStore, {
      id: () => `session-assistant:${this.props.sessionId}`,
      parts: () => this.props.thread()?.uiParts ?? [],
      streaming: () => false,
      submitting: () => this.processing,
      configuration: () => undefined,
      commands: () => [],
      placeholder: () => "Ask the session assistant…",
      inputLabel: () => "Message session assistant",
      canSubmit: (draft) => Boolean(draft.trim()) && !this.processing,
      submit: (draft) => this.runPrompt(draft, false),
      abort: () => this.abort(),
      focusRequestRevision: () => this.focusRequestRevision,
      error: () => ({ message: this.error }),
    });
  }

  @child
  get quickChatStore(): ChatStore {
    return createStore(ChatStore, {
      id: () => `session-assistant-quick:${this.props.sessionId}`,
      parts: () => this.quickParts,
      streaming: () => false,
      submitting: () => this.processing,
      configuration: () => undefined,
      commands: () => [],
      placeholder: () => "Ask the session assistant…",
      inputLabel: () => "Ask session assistant",
      canSubmit: (draft) => Boolean(draft.trim()) && !this.processing,
      submit: (draft) => this.runPrompt(draft, true),
      abort: () => this.abort(),
      composerVisible: () => !this.processing && this.quickParts.length === 0,
      focusRequestRevision: () => this.focusRequestRevision,
    });
  }

  beginQuickPrompt(composerSelection?: string) {
    this.composerSelection = composerSelection;
    this.quickParts.splice(0);
    this.quickChatStore.setDraft("");
    this.quickResponseRevision = 0;
    this.error = undefined;
    this.requestFocus();
  }

  beginChat(composerSelection?: string) {
    this.composerSelection = composerSelection;
    this.error = undefined;
    this.requestFocus();
  }

  requestFocus() {
    this.focusRequestRevision += 1;
  }

  private async runPrompt(prompt: string, quick: boolean) {
    const text = prompt.trim();
    if (!text || this.processing) return false;
    this.error = undefined;
    try {
      const selection = this.composerSelection;
      // The parent composer's selection travels with this one message as
      // user-provided context rather than living in the system prompt.
      this.composerSelection = undefined;
      const annotation = selection ? composerSelectionAnnotation(selection) : undefined;
      if (quick) this.quickTurnPending = true;
      const ensured = await this.ensureDiscussion(text, annotation);
      if (!ensured || this.signal.aborted) return false;
      const { discussion, startedTurnId } = ensured;
      const model = discussion.model;
      const settledBefore = model.settledTurnRevision;
      if (startedTurnId === undefined) {
        if (annotation) discussion.chatStore.addAnnotation(annotation);
        const submitted = await discussion.chatStore.submit(text);
        if (!submitted) return false;
      }
      if (!quick) return true;
      // Settlement arrives as an event. A turn started by `ensure` may already
      // have settled before this window subscribed, in which case the first
      // snapshot shows the completed reply instead.
      const settled = await this.waitFor(
        () =>
          model.observedSnapshotRevision > 0 &&
          (startedTurnId === undefined
            ? model.settledTurnRevision > settledBefore
            : model.settledTurns.some((turn) => turn.turnId === startedTurnId) ||
              (!model.streaming &&
                model.activeTurnIds.length === 0 &&
                latestAssistantReply(model.uiParts).length > 0)),
      );
      if (!settled) return false;
      this.quickParts.splice(0, this.quickParts.length, ...latestAssistantReply(model.uiParts));
      this.quickResponseRevision += 1;
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
      return false;
    } finally {
      this.quickTurnPending = false;
    }
  }

  /**
   * Ensures the assistant's sidecar exists and waits for this window to observe
   * it. A brand-new assistant is started with this message, as any side chat is.
   */
  private async ensureDiscussion(
    text: string,
    annotation: Omit<Annotation, "id"> | undefined,
  ): Promise<{ discussion: DiscussionSessionStore; startedTurnId?: string } | undefined> {
    const existing = this.discussion;
    if (existing) return { discussion: existing };
    const controller = new AbortController();
    this.ensureRequest = controller;
    this.ensuring = true;
    try {
      const ensured = await this.client.discussionSessions.ensureSessionAssistant(
        {
          parentSessionId: this.props.sessionId,
          workingDirectory: this.props.workspacePath,
          tools: [...this.props.tools()],
          staged: this.props.staged(),
          stagedMessages: this.props.staged() ? [...this.props.stagedMessages()] : [],
          firstPrompt: {
            text,
            annotations: annotation ? [{ ...annotation, id: crypto.randomUUID() }] : [],
          },
        },
        { signal: AbortSignal.any([this.signal, controller.signal]) },
      );
      if (controller.signal.aborted) return undefined;
      const threadId = ensured.thread.id;
      const ready = await this.waitFor(
        () => Boolean(this.props.discussionSession(threadId)),
        controller.signal,
      );
      const discussion = ready ? this.props.discussionSession(threadId) : undefined;
      if (!discussion) return undefined;
      return ensured.turnId === undefined
        ? { discussion }
        : { discussion, startedTurnId: ensured.turnId };
    } finally {
      if (this.ensureRequest === controller) this.ensureRequest = undefined;
      this.ensuring = false;
    }
  }

  private waitFor(condition: () => boolean, signal?: AbortSignal): Promise<boolean> {
    if (condition()) return Promise.resolve(true);
    if (this.signal.aborted || signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener("abort", abort);
        signal?.removeEventListener("abort", abort);
        dispose();
        resolve(ready);
      };
      const abort = () => finish(false);
      this.signal.addEventListener("abort", abort, { once: true });
      signal?.addEventListener("abort", abort, { once: true });
      const dispose = reactiveEffect(() => {
        if (condition()) queueMicrotask(() => finish(true));
      });
    });
  }

  private async abort() {
    this.ensureRequest?.abort();
    await this.discussion?.chatStore.abort();
  }
}

function composerSelectionAnnotation(selection: string): Omit<Annotation, "id"> {
  return {
    messageId: "composer-selection",
    selectedText: selection,
    startOffset: 0,
    endOffset: selection.length,
    contextBefore: "",
    contextAfter: "",
  };
}

/** The assistant text produced after the user's most recent message. */
function latestAssistantReply(parts: readonly UiPart[]): UiPart[] {
  const lastUserIndex = parts.findLastIndex((part) => part.kind === "text" && part.role === "user");
  return parts
    .slice(lastUserIndex + 1)
    .filter((part) => part.kind === "text" && part.role === "assistant" && part.text.trim());
}
