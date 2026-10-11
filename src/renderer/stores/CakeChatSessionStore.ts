import { Store, child, createStore } from "r-state-tree";
import type { Conversation } from "../models/Conversation";
import type { ModelPreset } from "../../ipc/session-contract";
import { ClientContext } from "./context/ClientContext";
import { ConversationHistoryStore } from "./ConversationHistoryStore";
import { ConversationSessionStore } from "./ConversationSessionStore";
import type { ComposerDeliveryInput } from "./ConversationComposerStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import type { CakeChatPendingSessionsStore } from "./CakeChatPendingSessionsStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { CakeChatTarget } from "../../ipc/cake-chat-data";
import type { CakeChatControls } from "../models/CakeChatControls";
import type { WorkflowCatalog } from "../models/WorkflowCatalog";
import type { SubagentCatalog } from "../models/SubagentCatalog";
import { SubagentActivityStore } from "./SubagentActivityStore";
import { WorkflowRunStore } from "./WorkflowRunStore";
import { workflowOwnerReferences } from "../../utils/workflow-references";
import { RequestInspectorStore } from "./RequestInspectorStore";

export interface CakeChatSessionStoreProps {
  sessionId: string;
  model: Conversation;
  controls: CakeChatControls;
  subagentCatalog: SubagentCatalog;
  workflowCatalog(sessionId: string): WorkflowCatalog;
  target(): CakeChatTarget;
  pendingSessions: CakeChatPendingSessionsStore;
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
  get workflowRunStores(): WorkflowRunStore[] {
    return workflowOwnerReferences(this.model.uiParts).map((sessionId) =>
      createStore(WorkflowRunStore, {
        key: sessionId,
        model: this.props.workflowCatalog(sessionId),
      }),
    );
  }

  @child
  get subagentActivityStore(): SubagentActivityStore {
    return createStore(SubagentActivityStore, {
      sessionId: this.sessionId,
      model: this.props.subagentCatalog,
      parts: () => this.model.uiParts,
    });
  }

  @child
  get requestInspectorStore(): RequestInspectorStore {
    return createStore(RequestInspectorStore, { sessionId: this.sessionId });
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
      startSession: (input) => this.startSession(input),
      ensureSessionActive: () => true,
      composer: {
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
        history: this.history,
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
