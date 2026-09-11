import { Store, child, createStore, effect as reactiveEffect } from "r-state-tree";
import type { Session } from "../models/Session";
import type { ModelPreset } from "../../ipc/session-contract";
import { ClientContext } from "./context/ClientContext";
import { ConversationSessionStore } from "./ConversationSessionStore";
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
  constructor(props: CakeChatSessionStore["props"]) {
    super(props);
    this.effect(() => () => {
      this.props.operations.reset(`cake-chat-abort:${this.sessionId}`);
    });
  }

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
  get promptOwner() {
    return `cake-chat-prompt:${this.sessionId}`;
  }
  get configurationOwner() {
    return `cake-chat-configuration:${this.sessionId}`;
  }

  @child
  get conversationSessionStore(): ConversationSessionStore {
    return createStore(ConversationSessionStore, {
      sessionId: this.sessionId,
      model: this.model,
      operations: this.props.operations,
      composerOperationOwner: this.promptOwner,
      configurationOperationOwner: this.configurationOwner,
      canSubmit: () => true,
      composer: {
        renameSession: (name) => this.props.management.renameSession(this.sessionId, name),
        handoffSession: (entryId, prompt, resolveSource) =>
          this.props.management.handoff(this.sessionId, entryId, prompt, resolveSource),
        deliver: async (input) => {
          const observedSnapshotRevision = this.model.observedSnapshotRevision;
          const active = this.props.management.ensureSessionActive(this.sessionId);
          if (active !== true) {
            if (!(await active)) return false;
            if (!(await this.waitForActiveProjection(observedSnapshotRevision))) return false;
          }
          const target = this.props.target();
          const newSession = this.props.pendingSessions.newSessionRequest(this.sessionId);
          const prompt = {
            sessionId: input.sessionId,
            tools: target.tools,
            text: input.text,
            renderUserMessageAsMarkdown: input.renderUserMessageAsMarkdown,
            attachments: input.attachments,
          };
          if (newSession !== undefined) Object.assign(prompt, { newSession });
          await this.client.cakeChats.prompt(prompt, { signal: this.signal });
          this.props.pendingSessions.markMaterialized(this.sessionId);
        },
        editMessage: (input) =>
          this.client.cakeChats.editMessage(
            { ...this.props.target(), ...input },
            { signal: this.signal },
          ),
        compact: async (_sessionId, instructions) => {
          if (this.props.pendingSessions.isPending(this.sessionId))
            throw new Error("Compaction requires an existing conversation");
          await this.client.cakeChats.compact(
            { ...this.props.target(), instructions },
            { signal: this.signal },
          );
        },
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
        setConfiguration: (configuration) =>
          this.client.cakeChats.applyConfiguration(
            { ...this.props.target(), configuration },
            { signal: this.signal },
          ),
        setModel: (provider, modelId) =>
          this.client.cakeChats.setModel(
            { ...this.props.target(), provider, modelId },
            { signal: this.signal },
          ),
        setThinkingLevel: (level) =>
          this.client.cakeChats.setThinkingLevel(
            { ...this.props.target(), level },
            { signal: this.signal },
          ),
        setFastMode: (enabled) =>
          this.client.cakeChats.setFastMode(
            { ...this.props.target(), enabled },
            { signal: this.signal },
          ),
      },
      chat: {
        commands: () => this.model.commands.filter((command) => command.name !== "sidechat"),
        placeholder: () => "Ask Cake to find or control a task…",
        inputLabel: () => "Message Cake Chat",
        userMessagePresentation: {
          setMarkdown: (entryId, renderAsMarkdown) =>
            this.client.cakeChats.setUserMessageMarkdown(
              { ...this.props.target(), entryId, renderAsMarkdown },
              { signal: this.signal },
            ),
        },
        isDraftSession: () =>
          this.props.pendingSessions.conversation(this.sessionId)?.isDraft ?? false,
        abort: () => this.abort(),
        configurationErrorFirst: true,
        errorTitle: "Cake Chat failed",
      },
      modelPresets: this.props.modelPresets,
      openModelPresetSettings: this.props.openModelPresetSettings,
      settings: this.props.settings,
      resetOperationOwnersOnDispose: true,
    });
  }

  /** Keeps the optimistic message and loading response visible until live observation is attached. */
  private waitForActiveProjection(afterRevision: number): Promise<boolean> {
    if (!this.model.resolved && this.model.observedSnapshotRevision > afterRevision)
      return Promise.resolve(true);
    if (this.signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener("abort", abort);
        dispose();
        resolve(ready);
      };
      const abort = () => finish(false);
      this.signal.addEventListener("abort", abort, { once: true });
      const dispose = reactiveEffect(() => {
        if (!this.model.resolved && this.model.observedSnapshotRevision > afterRevision)
          queueMicrotask(() => finish(true));
      });
    });
  }

  async abort() {
    if (!this.streaming) return;
    const operationId = this.props.operations.start(`cake-chat-abort:${this.sessionId}`);
    try {
      await this.client.cakeChats.abort(this.props.target(), {
        signal: this.signal,
      });
      this.props.operations.finish(operationId);
    } catch (error) {
      if (this.signal.aborted) return;
      this.props.operations.finish(operationId);
      this.conversationSessionStore.composerStore.reportError(error);
    }
  }
}
