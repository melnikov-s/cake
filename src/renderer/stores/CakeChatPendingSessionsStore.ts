import { Store, observable, snapshot } from "r-state-tree";
import {
  SESSION_TITLE_MAX_LENGTH,
  type Attachment,
  type ChatConfiguration,
} from "../../ipc/session-contract";
import type { CakeChatSummary } from "../../domain/cake-chat-data";
import type { JsonObject } from "../../ipc/json-contract";

export type CakeChatSummaryProjection = CakeChatSummary & { draft?: boolean };

export interface CakeControlTool {
  command: string;
  topic: string;
  summary: string;
  guidance?: readonly string[];
  parameters: JsonObject;
  examples?: readonly { input?: JsonObject; description?: string }[];
  result?: string;
  limitations?: readonly string[];
}

interface NewCakeChatSessionRequest {
  tools: ReadonlyArray<CakeControlTool>;
  configuration?: ChatConfiguration;
  name?: string;
}

interface PendingCakeChatSession {
  sessionId: string;
  started: boolean;
  configuration?: ChatConfiguration;
  name?: string;
  draftPrompt?: { text: string; attachments: Attachment[]; resolved: boolean };
  createdAt: string;
  modifiedAt: string;
  messageCount: number;
}

export interface CakeChatPendingSessionsStoreProps {
  defaultConfiguration?(): ChatConfiguration | undefined;
}

/** Owns persisted pending Cake Chat configuration, names, saved drafts, and materialization. */
export class CakeChatPendingSessionsStore extends Store<CakeChatPendingSessionsStoreProps> {
  @snapshot private readonly sessions: PendingCakeChatSession[] = observable([]);

  get pendingSessions(): readonly PendingCakeChatSession[] {
    return this.sessions;
  }

  get summaries(): readonly CakeChatSummaryProjection[] {
    return this.sessions.map((pending) => this.summary(pending));
  }

  firstUnstartedSessionId() {
    return this.sessions.find((session) => !session.started)?.sessionId;
  }

  create(sessionId: string, name?: string) {
    if (this.sessionFor(sessionId)) return false;
    const now = new Date().toISOString();
    this.sessions.push({
      sessionId,
      started: false,
      name,
      createdAt: now,
      modifiedAt: now,
      messageCount: 0,
    });
    return true;
  }

  remove(sessionId: string) {
    const index = this.sessions.findIndex((pending) => pending.sessionId === sessionId);
    if (index >= 0) this.sessions.splice(index, 1);
  }

  /** Drops renderer-pending metadata once the authoritative catalog contains the session. */
  reconcileMaterialized(authoritativeSessionIds: ReadonlySet<string>) {
    for (let index = this.sessions.length - 1; index >= 0; index -= 1)
      if (authoritativeSessionIds.has(this.sessions[index]!.sessionId))
        this.sessions.splice(index, 1);
  }

  isPending(sessionId: string) {
    return this.sessionFor(sessionId)?.started === false;
  }

  configuration(sessionId: string) {
    return this.isPending(sessionId)
      ? (this.sessionFor(sessionId)?.configuration ?? this.props.defaultConfiguration?.())
      : undefined;
  }

  setConfiguration(sessionId: string, configuration: ChatConfiguration) {
    if (!this.isPending(sessionId)) return;
    this.update(sessionId, (pending) => ({ ...pending, configuration }));
  }

  isDraft(sessionId: string) {
    return this.isPending(sessionId) && this.sessionFor(sessionId)?.draftPrompt !== undefined;
  }

  draftPrompt(sessionId: string) {
    return this.isDraft(sessionId) ? this.sessionFor(sessionId)?.draftPrompt : undefined;
  }

  createDraft(sessionId: string, text: string, attachments: Attachment[]) {
    if (!this.isPending(sessionId)) return false;
    this.update(sessionId, (pending) => ({
      ...pending,
      draftPrompt: { text, attachments: attachments.slice(), resolved: false },
      modifiedAt: new Date().toISOString(),
    }));
    return true;
  }

  updateDraft(sessionId: string, text: string, attachments: Attachment[]) {
    if (!this.isDraft(sessionId)) return false;
    this.update(sessionId, (pending) => ({
      ...pending,
      draftPrompt: {
        text,
        attachments: attachments.slice(),
        resolved: pending.draftPrompt?.resolved ?? false,
      },
      modifiedAt: new Date().toISOString(),
    }));
    return true;
  }

  activateDraft(sessionId: string) {
    if (!this.isDraft(sessionId)) return undefined;
    const prompt = this.sessionFor(sessionId)?.draftPrompt;
    this.update(sessionId, (pending) => ({
      ...pending,
      draftPrompt: undefined,
      modifiedAt: new Date().toISOString(),
    }));
    return prompt;
  }

  applyGeneratedDraftName(sessionId: string, name: string) {
    if (!this.isDraft(sessionId) || this.sessionFor(sessionId)?.name) return;
    this.rename(sessionId, name);
  }

  rename(sessionId: string, name: string) {
    if (!this.isPending(sessionId)) return false;
    const title = name.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
    if (!title) return false;
    this.update(sessionId, (pending) => ({
      ...pending,
      name: title,
      modifiedAt: new Date().toISOString(),
    }));
    return true;
  }

  setDraftResolved(sessionId: string, resolved: boolean) {
    if (!this.isDraft(sessionId)) return false;
    this.update(sessionId, (pending) => ({
      ...pending,
      draftPrompt: pending.draftPrompt ? { ...pending.draftPrompt, resolved } : undefined,
      modifiedAt: new Date().toISOString(),
    }));
    return true;
  }

  newSessionRequest(sessionId: string, tools: ReadonlyArray<CakeControlTool>) {
    if (!this.isPending(sessionId)) return undefined;
    const request: NewCakeChatSessionRequest = { tools };
    const configuration = this.configuration(sessionId);
    if (configuration !== undefined) request.configuration = configuration;
    const pending = this.sessionFor(sessionId);
    if (pending?.name !== undefined) request.name = pending.name;
    return request;
  }

  markMaterialized(sessionId: string) {
    if (!this.isPending(sessionId)) return;
    this.update(sessionId, (pending) => ({
      ...pending,
      started: true,
      configuration: undefined,
      draftPrompt: undefined,
      modifiedAt: new Date().toISOString(),
      messageCount: Math.max(1, pending.messageCount),
    }));
  }

  isResolved(sessionId: string) {
    return this.sessionFor(sessionId)?.draftPrompt?.resolved ?? false;
  }

  private summary(pending: PendingCakeChatSession): CakeChatSummaryProjection {
    return {
      sessionId: pending.sessionId,
      title: pending.name?.slice(0, SESSION_TITLE_MAX_LENGTH) ?? "New chat",
      createdAt: pending.createdAt,
      modifiedAt: pending.modifiedAt,
      messageCount: pending.messageCount,
      resolved: pending.draftPrompt?.resolved ?? false,
      draft: pending.draftPrompt !== undefined,
    };
  }

  private sessionFor(sessionId: string) {
    return this.sessions.find((pending) => pending.sessionId === sessionId);
  }

  private update(
    sessionId: string,
    update: (pending: PendingCakeChatSession) => PendingCakeChatSession,
  ) {
    const index = this.sessions.findIndex((pending) => pending.sessionId === sessionId);
    if (index >= 0) this.sessions.splice(index, 1, update(this.sessions[index]!));
  }
}
