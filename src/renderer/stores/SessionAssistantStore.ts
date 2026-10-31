import { child, createStore, effect as reactiveEffect, observable, Store } from "r-state-tree";
import type { Annotation, UiPart } from "../../contracts/conversations/session-contract";
import { SESSION_ASSISTANT_ID } from "../../contracts/cake-chats/cake-chat-identity";
import type { AssistantContext } from "../../contracts/cake-chats/assistant-context";
import { sameAssistantContext } from "../../contracts/cake-chats/assistant-context";
import { describeError } from "../lib/error-details";
import { ChatStore } from "./ChatStore";
import type { CakeChatSessionStore } from "./CakeChatSessionStore";
import { ClientContext } from "./context/ClientContext";

export interface SessionAssistantStoreProps {
  session(): CakeChatSessionStore;
  context(): AssistantContext | null;
}

/** Window-owned presentation of the one app-wide permanent Durable companion. */
export class SessionAssistantStore extends Store<SessionAssistantStoreProps> {
  readonly quickParts: UiPart[] = observable([]);
  open = false;
  surface: "quick" | "chat" = "quick";
  error: string | undefined;
  focusRequestRevision = 0;
  composerSelection: string | undefined;
  processing = false;
  private context: AssistantContext | null = null;
  private transitions: Promise<void> = Promise.resolve();

  constructor(props: SessionAssistantStore["props"]) {
    super(props);
    this.effect(() => {
      const next = this.open ? this.props.context() : null;
      if (sameAssistantContext(this.context, next)) return;
      this.context = next;
      this.enqueueContext(next);
    });
  }

  get contextSessionId() {
    return this.props.context()?.sessionId;
  }
  get client() {
    return ClientContext.consume(this)!;
  }
  get session() {
    return this.props.session();
  }

  private enqueueContext(context: AssistantContext | null) {
    // Serialize actual entry/exit events before submissions; ordinary messages add no reminder.
    this.transitions = this.transitions
      .catch(() => undefined)
      .then(async () => {
        const session = this.session;
        await this.client.cakeChats.open(session.props.target(), { signal: this.signal });
        await this.client.cakeChats.assistantContext({ context }, { signal: this.signal });
      });
    void this.transitions.catch((error) => {
      this.error = describeError(error).message;
    });
  }

  @child get chatStore(): ChatStore {
    return createStore(ChatStore, {
      id: () => SESSION_ASSISTANT_ID,
      parts: () => this.session.model.uiParts,
      history: this.session.history,
      streaming: () => this.session.model.streaming,
      submitting: () => this.processing,
      configuration: () => undefined,
      commands: () => [],
      placeholder: () => "Ask the companion…",
      inputLabel: () => "Message session assistant",
      canSubmit: (draft) => Boolean(draft.trim()) && !this.processing,
      submit: (draft) => this.runPrompt(draft, false),
      abort: () => this.session.conversationSessionStore.chatStore.abort(),
      focusRequestRevision: () => this.focusRequestRevision,
      error: () => ({ message: this.error }),
    });
  }

  @child get quickChatStore(): ChatStore {
    return createStore(ChatStore, {
      id: () => `${SESSION_ASSISTANT_ID}:quick`,
      parts: () => this.quickParts,
      streaming: () => false,
      submitting: () => this.processing,
      configuration: () => undefined,
      commands: () => [],
      placeholder: () => "Ask the companion…",
      inputLabel: () => "Ask session assistant",
      canSubmit: (draft) => Boolean(draft.trim()) && !this.processing,
      submit: (draft) => this.runPrompt(draft, true),
      abort: () => this.session.conversationSessionStore.chatStore.abort(),
      composerVisible: () => !this.processing && this.quickParts.length === 0,
      focusRequestRevision: () => this.focusRequestRevision,
    });
  }

  openQuickPrompt(selection?: string) {
    if (!this.open) {
      this.surface = "quick";
      this.composerSelection = selection;
      this.quickParts.splice(0);
      this.error = undefined;
      this.open = true;
    } else if (this.surface === "quick" && (this.processing || this.quickParts.length > 0)) {
      // A quick reply/thinking bubble has no composer; focus the same conversation's chat.
      this.surface = "chat";
    }
    this.requestFocus();
  }
  beginChat(selection?: string) {
    this.surface = "chat";
    this.composerSelection = selection;
    this.error = undefined;
    this.requestFocus();
  }
  setOpen(open: boolean) {
    this.open = open;
  }
  requestFocus() {
    this.focusRequestRevision += 1;
  }

  private async runPrompt(prompt: string, quick: boolean) {
    const text = prompt.trim();
    if (!text || this.processing) return false;
    this.processing = true;
    this.error = undefined;
    try {
      await this.transitions;
      const session = this.session;
      const ready = await this.waitFor(() => session.model.observedSnapshotRevision > 0);
      if (!ready) return false;
      const selection = this.composerSelection;
      this.composerSelection = undefined;
      if (selection)
        session.conversationSessionStore.chatStore.addAnnotation(
          composerSelectionAnnotation(selection),
        );
      const composer = session.conversationSessionStore.composerStore;
      composer.draftStore.setText(text);
      const submitted = await composer.submit();
      if (submitted === false) {
        this.error = composer.error;
        return false;
      }
      if (!quick || !submitted || submitted === true) return true;
      // A preceding full-chat turn may settle while this quick prompt is queued.
      // Wait for our accepted turn, not merely the next settlement.
      if (
        !(await this.waitFor(() =>
          session.model.settledTurns.some((turn) => turn.turnId === submitted.turnId),
        ))
      )
        return false;
      this.quickParts.splice(
        0,
        this.quickParts.length,
        ...latestAssistantReply(session.model.uiParts),
      );
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
      return false;
    } finally {
      this.processing = false;
    }
  }

  private waitFor(condition: () => boolean): Promise<boolean> {
    if (condition()) return Promise.resolve(true);
    if (this.signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (ready: boolean) => {
        this.signal.removeEventListener("abort", abort);
        dispose();
        resolve(ready);
      };
      const abort = () => finish(false);
      this.signal.addEventListener("abort", abort, { once: true });
      const dispose = reactiveEffect(() => {
        if (condition()) queueMicrotask(() => finish(true));
      });
    });
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
function latestAssistantReply(parts: readonly UiPart[]): UiPart[] {
  const lastUserIndex = parts.findLastIndex((part) => part.kind === "text" && part.role === "user");
  return parts
    .slice(lastUserIndex + 1)
    .filter((part) => part.kind === "text" && part.role === "assistant" && part.text.trim());
}
