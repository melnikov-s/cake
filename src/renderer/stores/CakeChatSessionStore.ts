import { Store, child, createStore } from "r-state-tree";
import type { Session } from "../models/Session";
import type { ModelPreset } from "../../ipc/session-contract";
import { ClientContext } from "./context/ClientContext";
import { ConversationSessionStore } from "./ConversationSessionStore";
import type { ComposerDeliveryInput } from "./ConversationComposerStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import type { CakeChatManagementStore } from "./CakeChatManagementStore";
import type { CakeChatPendingSessionsStore } from "./CakeChatPendingSessionsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { CakeChatTarget } from "../../domain/cake-chats/cake-chat-data";

export interface CakeChatSessionStoreProps {
  sessionId: string;
  model: Session;
  target(): CakeChatTarget;
  pendingSessions: CakeChatPendingSessionsStore;
  management: CakeChatManagementStore;
  operations: SessionOperationCoordinatorStore;
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
  settings?(): AppearanceSettingsStore | undefined;
}

/** Owns the configuration and shared conversation input workflow for one Cake Chat session. */
export class CakeChatSessionStore extends Store<CakeChatSessionStoreProps> {
  get model() {
    return this.props.model;
  }
  get client() {
    return ClientContext.consume(this)!;
  }
  get sessionId() {
    return this.props.sessionId;
  }
  get streaming() {
    return this.model.streaming;
  }
  @child
  get conversationSessionStore(): ConversationSessionStore {
    return createStore(ConversationSessionStore, {
      sessionId: this.sessionId,
      model: this.model,
      operations: this.props.operations,
      canSubmit: () => true,
      startSession: (input) => this.startSession(input),
      ensureSessionActive: () => this.props.management.ensureSessionActive(this.sessionId),
      composer: {
        renameSession: (name) => this.props.management.renameSession(this.sessionId, name),
        toolCompactSession: (entryId, prompt) =>
          this.props.management.toolCompact(this.sessionId, entryId, prompt),
        draftSessionPrompt: (sessionId) =>
          this.props.pendingSessions.conversation(sessionId)?.draftPrompt,
        isDeferredSession: (sessionId) => this.props.pendingSessions.isPending(sessionId),
        createDraftSession: (sessionId, text, attachments) => {
          const conversation = this.props.pendingSessions.conversation(sessionId);
          if (!conversation || !this.props.pendingSessions.isPending(sessionId)) return false;
          conversation.createDraft(text, attachments);
          return true;
        },
        updateDraftSession: (sessionId, text, attachments) =>
          this.props.pendingSessions.conversation(sessionId)?.updateDraft(text, attachments) ??
          false,
        activateDraftSession: (sessionId) =>
          this.props.pendingSessions.conversation(sessionId)?.activateDraft(),
        applyGeneratedDraftName: (sessionId, title) =>
          this.props.pendingSessions.conversation(sessionId)?.applyGeneratedDraftName(title),
        editorText: (entryId) =>
          this.model.tree.find((entry) => entry.piId === entryId)?.editorText,
      },
      configuration: {
        deferredNewSession: () => this.props.pendingSessions.isPending(this.sessionId),
        effectiveConfiguration: () => this.props.pendingSessions.configuration(this.sessionId),
        setPendingConfiguration: (configuration) =>
          this.props.pendingSessions.conversation(this.sessionId)?.setConfiguration(configuration),
      },
      chat: {
        commands: () => this.model.commands.filter((command) => command.name !== "sidechat"),
        placeholder: () => "Ask Cake to find or control a task…",
        inputLabel: () => "Message Cake Chat",
        isDraftSession: () =>
          this.props.pendingSessions.conversation(this.sessionId)?.isDraft ?? false,
      },
      modelPresets: this.props.modelPresets,
      openModelPresetSettings: this.props.openModelPresetSettings,
      settings: this.props.settings,
    });
  }

  private async startSession(input: ComposerDeliveryInput) {
    const newSession = this.props.pendingSessions.newSessionRequest(this.sessionId);
    if (!newSession) return false;
    await this.client.cakeChats.start(
      {
        sessionId: input.sessionId,
        tools: this.props.target().tools,
        text: input.text,
        renderUserMessageAsMarkdown: input.renderUserMessageAsMarkdown,
        attachments: input.attachments,
        newSession,
      },
      { signal: this.signal },
    );
    this.props.pendingSessions.markMaterialized(this.sessionId);
    return true;
  }
}
