import { Store, child, createStore, observable } from "r-state-tree";
import type { InterviewRecord, InterviewResult } from "../../contracts/interviews/interview";
import type { StoreEvent } from "../events/StoreEvent";
import { isSessionAssistantThread } from "../../contracts/discussion-sessions/discussion-session-data";
import type { ModelPreset, UiPart } from "../../contracts/conversations/session-contract";
import type { ReviewThread } from "../models/ReviewThread";
import type { Conversation } from "../models/Conversation";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { ConversationSessionStore } from "./ConversationSessionStore";
import { ConversationHistoryStore } from "./ConversationHistoryStore";
import { InterviewStore } from "./InterviewStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface DiscussionSessionStoreProps {
  /** Cake-owned thread metadata from the parent's Discussion catalog. */
  thread: ReviewThread;
  /** The sidecar's live conversation, observed like any other Cake Session. */
  model: Conversation;
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
  private readonly interviewRequests = observable(
    new Map<string, Extract<StoreEvent, { type: "interview-requested" }>>(),
  );

  constructor(props: DiscussionSessionStore["props"]) {
    super(props);
    this.reaction(
      () =>
        this.model.uiParts.flatMap((part) =>
          part.kind === "tool" && part.interview && part.state !== "running"
            ? [part.interview.id]
            : [],
        ),
      (settled) => {
        for (const id of settled) this.interviewRequests.delete(id);
      },
    );
  }

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

  /** A live request belongs to this sidecar, never its parent conversation. */
  receive(event: Extract<StoreEvent, { type: "interview-requested" }>) {
    if (event.record.sessionId !== this.sessionId) return;
    this.interviewRequests.set(event.record.id, event);
  }

  @child
  get interviews(): InterviewStore[] {
    const records = new Map<string, { record: InterviewRecord; result?: InterviewResult }>();
    for (const part of this.model.uiParts)
      if (part.kind === "tool" && part.interview?.sessionId === this.sessionId)
        records.set(part.interview.id, { record: part.interview, result: part.interviewResult });
    // A request can arrive before its Pi tool metadata reaches the projection.
    for (const [id, request] of this.interviewRequests)
      if (!records.has(id)) records.set(id, { record: request.record });
    return [...records.values()].map(({ record, result }) =>
      createStore(InterviewStore, {
        key: record.id,
        record,
        result,
        request: this.interviewRequests.get(record.id),
        operations: this.props.operations,
        isStreaming: () => this.streaming,
        onResponded: () => {
          this.interviewRequests.delete(record.id);
        },
      }),
    );
  }

  get waitingForInterview() {
    return this.interviewRequests.size > 0;
  }

  resolve() {
    return this.props.setResolved(true);
  }

  reopen() {
    return this.props.setResolved(false);
  }

  @child
  get history(): ConversationHistoryStore {
    return createStore(ConversationHistoryStore, { model: this.model });
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
        history: this.history,
        commands: () => [],
        placeholder: () =>
          this.isSessionAssistant ? "Ask the session assistant…" : "Ask a follow-up…",
        // The assistant always runs on the utility model, which the runtime
        // reapplies on every acquisition, so offering a picker would mislead.
        modelPickerVisible: () => !this.isSessionAssistant,
        inputLabel: () =>
          this.isSessionAssistant
            ? "Message session assistant"
            : this.thread.anchor.view === "message" || this.thread.anchor.view === "artifact"
              ? "Reply to selection side chat"
              : this.thread.anchor.view === "session"
                ? "Reply to side chat"
                : "Reply to code chat",
        leadingParts: () => this.anchorParts,
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
