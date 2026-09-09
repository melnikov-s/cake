import { Store, snapshot } from "r-state-tree";
import {
  SESSION_TITLE_MAX_LENGTH,
  type Attachment,
  type ChatConfiguration,
} from "../../ipc/session-contract";

export interface PendingConversationPrompt {
  text: string;
  attachments: Attachment[];
  resolved: boolean;
}

export interface PendingConversationStoreProps {
  sessionId: string;
}

/** Owns the persisted per-conversation state shared by pending Project and Cake Chat owners. */
export class PendingConversationStore extends Store<PendingConversationStoreProps> {
  @snapshot name: string | undefined;
  @snapshot configuration: ChatConfiguration | undefined;
  @snapshot draftPrompt: PendingConversationPrompt | undefined;
  @snapshot fallbackTitle: string | undefined;
  @snapshot createdAt = new Date().toISOString();
  @snapshot modifiedAt = this.createdAt;
  @snapshot messageCount = 0;

  get sessionId() {
    return this.props.sessionId;
  }

  get isDraft() {
    return this.draftPrompt !== undefined;
  }

  get resolved() {
    return this.draftPrompt?.resolved ?? false;
  }

  get title() {
    return this.name?.slice(0, SESSION_TITLE_MAX_LENGTH) ?? this.fallbackTitle ?? "New chat";
  }

  setConfiguration(configuration: ChatConfiguration) {
    this.configuration = configuration;
  }

  setName(name: string) {
    this.name = name.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
    this.touch();
  }

  setFallbackTitle(title: string) {
    this.fallbackTitle = title.trim().slice(0, SESSION_TITLE_MAX_LENGTH) || "New chat";
    this.touch();
  }

  applyGeneratedDraftName(name: string) {
    if (!this.isDraft || this.name || !name.trim()) return;
    this.setName(name);
  }

  createDraft(text: string, attachments: Attachment[]) {
    this.draftPrompt = {
      text,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      resolved: false,
    };
    this.touch();
  }

  updateDraft(text: string, attachments: Attachment[]) {
    if (!this.draftPrompt) return false;
    this.draftPrompt = {
      text,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      resolved: this.draftPrompt.resolved,
    };
    this.touch();
    return true;
  }

  activateDraft() {
    const prompt = this.draftPrompt;
    if (!prompt) return undefined;
    this.draftPrompt = undefined;
    this.touch();
    return prompt;
  }

  setDraftResolved(resolved: boolean) {
    if (!this.draftPrompt) return false;
    this.draftPrompt = { ...this.draftPrompt, resolved };
    this.touch();
    return true;
  }

  markMaterialized() {
    this.configuration = undefined;
    this.draftPrompt = undefined;
    this.messageCount = Math.max(1, this.messageCount);
    this.touch();
  }

  touch() {
    this.modifiedAt = new Date().toISOString();
  }
}
