import { child, createStore, Store, untracked } from "r-state-tree";
import type { ChatConfiguration } from "../../ipc/session-contract";
import type { SavedDraft } from "../../domain/project-sessions/saved-draft-data";
import type { Conversation } from "../models/Conversation";
import { ClientError } from "../client/Client";
import { ClientContext } from "./context/ClientContext";
import { ChatStore } from "./ChatStore";
import { ChatConfigurationStore } from "./ChatConfigurationStore";
import { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { ArtifactInteractionStore } from "./ArtifactInteractionStore";

/** One browser conversation's presentation/delivery workflow. Backend/Pi remain authority.
 * Draft is owned by shared ChatStore, memory-only for this tab. Commands are single-flight;
 * an uncertain receipt retains text, blocks sends, and requires an explicit user decision.
 */
export class BrowserSessionStore extends Store<{
  sessionId: string;
  projectPath: string;
  workingDirectory: string;
  staged: boolean;
  known(): boolean;
  connected(): boolean;
  catalogReady(): boolean;
  model: Conversation;
  savedDraft(): SavedDraft | undefined;
  updateSavedDraft(record: SavedDraft, text: string): Promise<SavedDraft>;
  activateSavedDraft(record: SavedDraft): Promise<{ record: SavedDraft; workingDirectory: string }>;
  recoverUncertainDraft(record: SavedDraft): Promise<SavedDraft>;
  refreshSavedDrafts(): Promise<void>;
}> {
  constructor(props: BrowserSessionStore["props"]) {
    super(props);
    this.effect(() => {
      const created = this.created;
      const connected = this.connected;
      // Reacquisition is safe after a new socket; turn submission is never part of this effect.
      if (created && connected)
        untracked(() => {
          void this.open();
        });
    });
  }

  focusRevision = 0;
  opened = false;
  opening = false;
  synchronized = false;
  accepted = false;
  uncertain = false;
  error: string | undefined;
  pendingConfiguration: ChatConfiguration | undefined;
  savedDraftInput: string | undefined;
  get savedDraftEditText() {
    return this.savedDraftInput ?? this.savedDraft?.text ?? "";
  }
  setSavedDraftEditText(text: string) {
    this.savedDraftInput = text;
  }
  async saveSavedDraftEdit() {
    const record = this.savedDraft;
    if (record?.status !== "saved" || !this.connected) return;
    try {
      await this.props.updateSavedDraft(record, this.savedDraftEditText);
      this.savedDraftInput = undefined;
      this.error = undefined;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      await this.props.refreshSavedDrafts();
    }
  }
  get id() {
    return this.props.sessionId;
  }
  get model() {
    return this.props.model;
  }
  get workingDirectory() {
    return this.props.workingDirectory;
  }
  get created() {
    return !this.props.staged || this.accepted || this.props.known();
  }
  get savedDraft() {
    return this.props.savedDraft();
  }
  get connected() {
    return this.props.connected();
  }
  get readyToReconcile() {
    return this.connected && this.props.catalogReady() && (!this.created || this.synchronized);
  }
  get client() {
    return ClientContext.consume(this)!;
  }

  @child get operations(): SessionOperationCoordinatorStore {
    return createStore(SessionOperationCoordinatorStore);
  }
  @child get configuration(): ChatConfigurationStore {
    return createStore(ChatConfigurationStore, {
      session: () => this.model,
      operations: this.operations,
      presets: () => [],
      deferredNewSession: () => !this.created,
      effectiveConfiguration: () => this.pendingConfiguration,
      setPendingConfiguration: (configuration) => {
        this.pendingConfiguration = configuration;
      },
      setConfiguration: (configuration) =>
        this.client.sessionChats.applyConfiguration(
          { sessionId: this.id, configuration },
          { signal: this.signal },
        ),
      setModel: (provider, modelId) =>
        this.client.sessionChats.setModel(
          { sessionId: this.id, provider, modelId },
          { signal: this.signal },
        ),
      setThinkingLevel: (level) =>
        this.client.sessionChats.setThinkingLevel(
          { sessionId: this.id, level },
          { signal: this.signal },
        ),
      setFastMode: (enabled) =>
        this.client.sessionChats.setFastMode(
          { sessionId: this.id, enabled },
          { signal: this.signal },
        ),
    });
  }
  @child get interaction(): ArtifactInteractionStore {
    return createStore(ArtifactInteractionStore, {
      sessionContext: () => ({ sessionId: this.id }),
      operations: this.operations,
      operationOwner: this.id,
      isStreaming: () => this.model.streaming,
    });
  }
  @child get chat(): ChatStore {
    return createStore(ChatStore, {
      id: () => this.id,
      parts: () => {
        const record = this.savedDraft;
        return record?.status === "saved"
          ? [
              {
                id: `draft-${this.id}-text`,
                kind: "text" as const,
                role: "user" as const,
                entryId: `draft:${this.id}`,
                text: record.text,
                status: "complete" as const,
                draft: true,
              },
            ]
          : this.model.uiParts;
      },
      streaming: () => this.connected && this.model.streaming,
      stoppable: () => this.connected && this.model.activeTurnIds.length > 0,
      submitting: () => false,
      configuration: () => this.configuration,
      // A deferred choice is captured by start; do not offer a second local choice
      // while that receipt is pending or before its authoritative snapshot arrives.
      modelPickerVisible: () =>
        this.connected &&
        !this.chat.submittingLocally &&
        !this.uncertain &&
        this.savedDraft?.status !== "activating" &&
        this.configuration.activeOperations.length === 0 &&
        (!this.created || (this.opened && this.synchronized)),
      commands: () => this.model.commands,
      placeholder: () => "Message Cake…",
      inputLabel: () => "Message Cake",
      isDraftSession: () => this.savedDraft?.status === "saved",
      activateDraft: () => this.activateSavedDraft(),
      canSubmit: (draft) =>
        Boolean(draft.trim()) &&
        this.connected &&
        this.props.catalogReady() &&
        !this.uncertain &&
        this.savedDraft?.status !== "activating" &&
        this.configuration.activeOperations.length === 0 &&
        (!this.created || (this.opened && this.synchronized)),
      submit: (draft, options) => this.submit(draft, options?.renderUserMessageAsMarkdown ?? false),
      abort: () => this.stop(),
      usage: () => this.model.usage,
      focusRequestRevision: () => this.focusRevision,
      hideThinking: () => Boolean(this.model.piSettings?.hideThinkingBlock),
      error: () => ({
        message: this.uncertain
          ? undefined
          : (this.error ?? this.configuration.error ?? this.interaction.error),
      }),
    });
  }
  async open() {
    if (!this.created || this.opened || this.opening || !this.connected) return;
    this.opening = true;
    this.error = undefined;
    try {
      await this.client.projectSessions.open(
        { sessionId: this.id, workingDirectory: this.workingDirectory },
        { signal: this.signal },
      );
      if (!this.signal.aborted && this.connected) this.opened = true;
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.opening = false;
    }
  }
  disconnected() {
    this.synchronized = false;
    this.opened = false;
    this.interaction.request = undefined;
  }
  receivedSnapshot() {
    this.synchronized = true;
  }
  /** Does not resubmit anything. The user checks the fresh transcript before deciding. */
  acknowledgeUncertainty(discard: boolean) {
    if (!this.readyToReconcile) return;
    this.uncertain = false;
    this.error = undefined;
    if (discard) this.chat.setDraft("");
  }
  async recoverUncertainDraft() {
    const record = this.savedDraft;
    if (record?.status !== "activating" || !this.connected) return;
    try {
      await this.props.recoverUncertainDraft(record);
      this.uncertain = false;
      this.error = undefined;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      await this.props.refreshSavedDrafts();
    }
  }
  private async activateSavedDraft() {
    const record = this.savedDraft;
    if (record?.status !== "saved" || !this.connected) return false;
    try {
      await this.props.activateSavedDraft(record);
      this.accepted = true;
      this.opened = true;
      return true;
    } catch (error) {
      this.uncertain =
        error instanceof ClientError && error.kind !== "rejected" && error.kind !== "unsupported";
      this.error = error instanceof Error ? error.message : String(error);
      await this.props.refreshSavedDrafts();
      return false;
    }
  }
  private async submit(text: string, renderUserMessageAsMarkdown: boolean) {
    if (this.savedDraft?.status === "activating") return false;
    this.error = undefined;
    const saved = this.savedDraft?.status === "saved" ? this.savedDraft : undefined;
    try {
      if (saved) {
        await this.props.updateSavedDraft(saved, text);
        return true;
      }
      if (!this.created) {
        await this.client.projectSessions.start(
          {
            sessionId: this.id,
            projectPath: this.props.projectPath,
            workingDirectory: this.workingDirectory,
            configuration: this.pendingConfiguration,
            text,
            attachments: [],
            renderUserMessageAsMarkdown,
          },
          { signal: this.signal },
        );
        this.opened = true;
        this.accepted = true;
      } else {
        await this.client.sessionChats.prompt(
          { sessionId: this.id, text, attachments: [], renderUserMessageAsMarkdown },
          { signal: this.signal },
        );
      }
      return true;
    } catch (error) {
      if (!this.signal.aborted) {
        if (saved) await this.props.refreshSavedDrafts();
        // A transport failure cannot prove rejection. Never automatically replay a mutation.
        this.uncertain =
          error instanceof ClientError && error.kind !== "rejected" && error.kind !== "unsupported";
        this.error = this.uncertain
          ? "Delivery is uncertain. Check the refreshed transcript before sending again."
          : error instanceof Error
            ? error.message
            : String(error);
      }
      return false;
    }
  }
  private async stop() {
    try {
      await this.client.sessionChats.abort({ sessionId: this.id }, { signal: this.signal });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
}
