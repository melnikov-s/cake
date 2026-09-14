import { Store, child, createStore } from "r-state-tree";
import { isSessionAssistantThread } from "../../domain/discussion-sessions/discussion-session-data";
import type { ModelPreset, UiPart } from "../../ipc/session-contract";
import type { ReviewThread } from "../models/ReviewThread";
import type { Session } from "../models/Session";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { ConversationSessionStore } from "./ConversationSessionStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface DiscussionSessionStoreProps {
  /** Cake-owned thread metadata from the parent's Discussion catalog. */
  thread: ReviewThread;
  /** The sidecar's live conversation, observed like any other Cake Session. */
  model: Session;
  operations: SessionOperationCoordinatorStore;
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
  settings?(): AppearanceSettingsStore | undefined;
  setResolved(resolved: boolean): Promise<boolean>;
}

/**
 * One Discussion Session: thread metadata wrapped around the same shared
 * conversation workflow that Project Sessions and Cake Chat use, so a side
 * chat prompts, queues, steers, stops, edits, and configures identically.
 */
export class DiscussionSessionStore extends Store<DiscussionSessionStoreProps> {
  get thread() {
    return this.props.thread;
  }

  get threadId() {
    return this.thread.id;
  }

  /** The parent's assistant side chat, as opposed to a user-opened side chat. */
  get isSessionAssistant() {
    return isSessionAssistantThread(this.thread);
  }

  /** The sidecar Pi Session ID every shared conversation operation addresses. */
  get sessionId() {
    return this.props.model.sessionId;
  }

  get model() {
    return this.props.model;
  }

  get streaming() {
    return this.model.streaming;
  }

  get chatStore() {
    return this.conversationSessionStore.chatStore;
  }

  get configurationStore() {
    return this.conversationSessionStore.configurationStore;
  }

  resolve() {
    return this.props.setResolved(true);
  }

  reopen() {
    return this.props.setResolved(false);
  }

  @child
  get conversationSessionStore(): ConversationSessionStore {
    return createStore(ConversationSessionStore, {
      sessionId: this.sessionId,
      model: this.model,
      operations: this.props.operations,
      canSubmit: () => true,
      // The sidecar is retained by this window's observation; a command issued
      // before the first snapshot lands waits for it instead of racing it.
      ensureSessionActive: () => this.model.observedSnapshotRevision > 0 || Promise.resolve(true),
      composer: {
        renameSession: async () => {
          throw new Error("Side chats cannot be renamed");
        },
        toolCompactSession: async () => {
          throw new Error("Side chats do not support /toolcompact");
        },
        editorText: (entryId) =>
          this.model.tree.find((entry) => entry.piId === entryId)?.editorText,
      },
      configuration: {},
      chat: {
        commands: () => [],
        placeholder: () =>
          this.isSessionAssistant ? "Ask the session assistant…" : "Ask a follow-up…",
        // The assistant always runs on the utility model, which the runtime
        // reapplies on every acquisition, so offering a picker would mislead.
        modelPickerVisible: () => !this.isSessionAssistant,
        inputLabel: () =>
          this.isSessionAssistant
            ? "Message session assistant"
            : this.thread.anchor.view === "message"
              ? "Reply to selection side chat"
              : this.thread.anchor.view === "session"
                ? "Reply to side chat"
                : "Reply to code chat",
        leadingParts: () => this.anchorParts,
        addAttachments: () =>
          this.conversationSessionStore.composerStore.draftStore.addAttachments(),
        suggestFiles: (prefix) =>
          this.conversationSessionStore.composerStore.draftStore.suggestFiles(prefix),
        rewordWorkingDirectory: () => this.thread.workingDirectory,
      },
      modelPresets: this.props.modelPresets,
      openModelPresetSettings: this.props.openModelPresetSettings,
      settings: this.props.settings,
    });
  }

  /** The selected code or passage the thread discusses, shown as its opening context. */
  private get anchorParts(): UiPart[] {
    const selectedText = this.thread.anchor.selectedText;
    return selectedText
      ? [
          {
            id: `anchor:${this.threadId}`,
            kind: "text",
            role: "user",
            text: selectedText,
            status: "complete",
          },
        ]
      : [];
  }
}
