import { Store, child, createStore, snapshot } from "r-state-tree";
import type { AutomationSessionIdentity } from "../../contracts/automations/automation-data";
import type { ModelPreset } from "../../contracts/conversations/session-contract";
import type { Conversation } from "../models/Conversation";
import { ConversationSessionStore } from "./ConversationSessionStore";
import { ConversationHistoryStore } from "./ConversationHistoryStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { ClientContext } from "./context/ClientContext";

/** Automation policy binds the existing Conversation/Chat machinery, never a Project shadow. */
export class AutomationSessionStore extends Store<{
  identity: AutomationSessionIdentity;
  model: Conversation;
  initialTitle: string;
  currentTitle(): string | undefined;
  resolved(): boolean;
  operations: SessionOperationCoordinatorStore;
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
}> {
  @snapshot title = this.props.initialTitle;
  lifecyclePending = false;
  error: string | undefined;
  private unreadUpdates: Promise<void> = Promise.resolve();

  constructor(props: AutomationSessionStore["props"]) {
    super(props);
    this.reaction(
      () => this.props.currentTitle(),
      (title) => {
        if (title) this.title = title;
      },
    );
  }

  get displayTitle() {
    return this.props.currentTitle() ?? this.title;
  }

  get identity() {
    return this.props.identity;
  }
  get sessionId() {
    return this.identity.sessionId;
  }
  get model() {
    return this.props.model;
  }
  get resolved() {
    return this.props.resolved();
  }
  private get client() {
    return ClientContext.consume(this)!;
  }

  @child get history(): ConversationHistoryStore {
    return createStore(ConversationHistoryStore, { model: this.model });
  }

  @child get conversationSessionStore(): ConversationSessionStore {
    return createStore(ConversationSessionStore, {
      sessionId: this.sessionId,
      model: this.model,
      operations: this.props.operations,
      canSubmit: () => this.ready,
      ensureSessionActive: () => !this.resolved,
      composer: {
        projectPath: () =>
          this.identity.context._tag === "Project" ? this.identity.context.projectPath : undefined,
        editorText: (entryId) =>
          this.model.tree.find((entry) => entry.piId === entryId)?.editorText,
      },
      configuration: {},
      chat: {
        contextUsage: true,
        history: this.history,
        commands: () => this.model.commands,
        placeholder: () => "Continue this automation run…",
        inputLabel: () => "Message automation run",
        rewordWorkingDirectory: () => this.identity.workingDirectory,
        suggestFiles: (prefix) =>
          this.client.filesystem.suggestFiles(this.identity.workingDirectory, prefix, {
            signal: this.signal,
          }),
      },
      modelPresets: this.props.modelPresets,
      openModelPresetSettings: this.props.openModelPresetSettings,
    });
  }

  private get ready() {
    return (
      !this.resolved &&
      this.model.observedSnapshotRevision > 0 &&
      !this.model.historyOnly &&
      !this.model.observationError
    );
  }

  /** Visibility only: restoring never triggers the automation or replays its task. */
  async setResolved(resolved: boolean) {
    if (this.lifecyclePending) return false;
    this.lifecyclePending = true;
    this.error = undefined;
    try {
      const target = { sessionId: this.sessionId, userInitiated: true };
      if (resolved) await this.client.projectSessions.resolve(target, { signal: this.signal });
      else await this.client.projectSessions.restore(target, { signal: this.signal });
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (!this.signal.aborted) this.lifecyclePending = false;
    }
  }

  setUnread(unread: boolean) {
    this.unreadUpdates = this.unreadUpdates.then(async () => {
      if (this.signal.aborted) return;
      try {
        await this.client.workspaces.setSessionUnread(this.sessionId, unread, {
          signal: this.signal,
        });
      } catch (error) {
        if (!this.signal.aborted)
          this.error = error instanceof Error ? error.message : String(error);
      }
    });
    return this.unreadUpdates;
  }
}
