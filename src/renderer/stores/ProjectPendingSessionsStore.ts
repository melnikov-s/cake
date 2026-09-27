import { Store, batch, child, createStore, observable, snapshot, untracked } from "r-state-tree";
import { SESSION_TITLE_MAX_LENGTH, type Attachment } from "../../ipc/session-contract";
import type { ProjectSessionStore } from "./ProjectSessionStore";
import type { SavedDraft } from "../../domain/project-sessions/saved-draft-data";
import type { Client } from "../client/Client";
import type { SessionCatalogStore, PendingSessionSummary } from "./SessionCatalogStore";

export type SavedDraftClient = Client["savedDrafts"];
import { PendingConversationStore } from "./PendingConversationStore";

export interface ProjectPendingSessionsStoreProps {
  catalog?: SessionCatalogStore;
  savedDrafts?: SavedDraftClient;
  session(sessionId: string): ProjectSessionStore | undefined;
  prepareIdentity(sessionId: string, workingDirectory: string): ProjectSessionStore;
  relocateIdentity(sessionId: string, workingDirectory: string): ProjectSessionStore;
  materializeIdentity(sessionId: string, workingDirectory: string): ProjectSessionStore;
  removeSession(sessionId: string): void;
  persistNow(): Promise<void>;
  projectName(workingDirectory: string): string;
}

interface ProjectPendingSummaryMetadata {
  familyId?: string;
  familyParentSessionId?: string;
  familyChildSessionIds?: string[];
  familyChildOrder?: number;
  familyDepth?: number;
}

/** Owns window-persisted staged, saved-draft, and starting Project Session workflows. */
export class ProjectPendingSessionsStore extends Store<ProjectPendingSessionsStoreProps> {
  @snapshot private readonly conversationIds: string[] = observable([]);
  // Pi may take time to include a newly started session in its disk-backed listing.
  @snapshot private readonly unlistedNewSessionIds: string[] = observable([]);
  @snapshot private readonly temporarySessionIds: string[] = observable([]);
  @snapshot private readonly summaryMetadataBySession: Record<
    string,
    ProjectPendingSummaryMetadata
  > = observable({});
  /** Unsent, unsaved project chats retained by independent session panes. */
  @snapshot private readonly stagedSessionIds: string[] = observable([]);
  private readonly submittingSessionIds: string[] = observable([]);
  private readonly savedRecords: Record<string, SavedDraft> = observable({});
  private loadRevision = 0;

  @child
  get conversations(): PendingConversationStore[] {
    return this.conversationIds.map((sessionId) =>
      createStore(PendingConversationStore, { key: sessionId, sessionId }),
    );
  }

  conversation(sessionId: string) {
    return this.conversations.find((conversation) => conversation.sessionId === sessionId);
  }

  get summaries(): readonly PendingSessionSummary[] {
    const visibleIds = new Set([
      ...Object.keys(this.savedRecords).filter(
        (id) => this.savedRecords[id]?.status !== "activated",
      ),
      ...this.conversations
        .filter((conversation) => conversation.isDraft)
        .map(({ sessionId }) => sessionId),
      ...this.submittingSessionIds,
      ...this.unlistedNewSessionIds,
    ]);
    return [...visibleIds].flatMap((sessionId) => {
      const session = this.props.session(sessionId);
      const conversation = this.conversation(sessionId);
      if (!session || !conversation) return [];
      const metadata = this.summaryMetadataBySession[sessionId];
      const managedWorktree = this.props.catalog?.managedWorktree(session.workspacePath);
      const projectPath = managedWorktree?.projectPath ?? session.workspacePath;
      return [
        {
          sessionId,
          title: conversation.title,
          createdAt: conversation.createdAt,
          modifiedAt: conversation.modifiedAt,
          messageCount: conversation.messageCount,
          resolved: conversation.resolved,
          unread: false,
          projectPath,
          projectName: this.props.projectName(projectPath),
          workingDirectory: session.workspacePath,
          ...(metadata?.familyId !== undefined ? { familyId: metadata.familyId } : null),
          ...(metadata?.familyParentSessionId !== undefined
            ? { familyParentSessionId: metadata.familyParentSessionId }
            : null),
          ...(metadata?.familyChildSessionIds !== undefined
            ? { familyChildSessionIds: metadata.familyChildSessionIds }
            : null),
          ...(metadata?.familyChildOrder !== undefined
            ? { familyChildOrder: metadata.familyChildOrder }
            : null),
          pending: true as const,
          draft: conversation.isDraft,
        },
      ];
    });
  }

  prepare(workingDirectory: string, sessionId: string) {
    const session = this.props.prepareIdentity(sessionId, workingDirectory);
    addUnique(this.temporarySessionIds, sessionId);
    this.ensureConversation(sessionId);
    return session;
  }

  prepareStaged(workingDirectory: string, sessionId: string) {
    const session = this.prepare(workingDirectory, sessionId);
    addUnique(this.stagedSessionIds, sessionId);
    return session;
  }

  familyId(sessionId: string) {
    return this.summaryMetadataBySession[sessionId]?.familyId;
  }

  trackFamilyParent(sessionId: string, familyId: string) {
    this.summaryMetadataBySession[sessionId] = {
      ...this.summaryMetadataBySession[sessionId],
      familyId,
    };
  }

  trackUnlistedFamilySession(
    sessionId: string,
    title: string,
    family: { familyId: string; parentSessionId: string; childOrder: number; depth: number },
  ) {
    const conversation = this.ensureConversation(sessionId);
    conversation.setName(title);
    conversation.fallbackTitle = title;
    this.summaryMetadataBySession[sessionId] = {
      familyId: family.familyId,
      familyParentSessionId: family.parentSessionId,
      familyChildOrder: family.childOrder,
      familyDepth: family.depth,
    };
    const parentMetadata = this.summaryMetadataBySession[family.parentSessionId];
    this.summaryMetadataBySession[family.parentSessionId] = {
      ...parentMetadata,
      familyId: family.familyId,
      familyChildSessionIds: [
        ...new Set([...(parentMetadata?.familyChildSessionIds ?? []), sessionId]),
      ],
    };
    addUnique(this.unlistedNewSessionIds, sessionId);
  }

  /** Pi may name the live session before its first assistant message persists a JSONL file. */
  applyLiveTitle(sessionId: string, title: string) {
    const conversation = this.conversation(sessionId);
    if (this.isTemporary(sessionId) && conversation && !conversation.name && !conversation.isDraft)
      conversation.setName(title);
  }

  materialize(sessionId: string, workingDirectory: string) {
    if (!this.temporarySessionIds.includes(sessionId))
      throw new Error("Only a successfully started renderer draft can be materialized.");
    return batch(() => {
      this.props.session(sessionId)?.stagedCommandStore.invalidate();
      const session = this.props.materializeIdentity(sessionId, workingDirectory);
      removeValue(this.temporarySessionIds, sessionId);
      removeValue(this.submittingSessionIds, sessionId);
      removeValue(this.stagedSessionIds, sessionId);
      this.conversation(sessionId)?.markMaterialized();
      if (this.props.catalog?.authoritativeSessionIds.includes(sessionId))
        this.clearSummary(sessionId);
      else addUnique(this.unlistedNewSessionIds, sessionId);
      return session;
    });
  }

  projectSubmission(sessionId: string, text: string) {
    if (!this.temporarySessionIds.includes(sessionId) || !this.props.session(sessionId)) return;
    const title = text.trim().slice(0, SESSION_TITLE_MAX_LENGTH) || "New chat";
    addUnique(this.submittingSessionIds, sessionId);
    removeValue(this.stagedSessionIds, sessionId);
    const conversation = this.ensureConversation(sessionId);
    conversation.setFallbackTitle(title);
    conversation.messageCount = Math.max(1, conversation.messageCount);
  }

  cancelSubmission(sessionId: string) {
    removeValue(this.submittingSessionIds, sessionId);
    if (this.temporarySessionIds.includes(sessionId)) addUnique(this.stagedSessionIds, sessionId);
  }

  isStaged(sessionId: string) {
    return this.stagedSessionIds.includes(sessionId);
  }

  isTemporary(sessionId: string) {
    return this.temporarySessionIds.includes(sessionId);
  }

  isDraft(sessionId: string) {
    return this.savedRecords[sessionId]?.status === "saved";
  }

  async createDraft(sessionId: string, text: string, attachments: Attachment[]) {
    if (!this.temporarySessionIds.includes(sessionId))
      throw new Error("Only a new session can be saved as a draft");
    const session = this.props.session(sessionId);
    if (!session) throw new Error("Cake could not find that new session");
    const projectPath =
      this.props.catalog?.projectOfManagedWorktree(session.workspacePath) ?? session.workspacePath;
    const conversation = this.ensureConversation(sessionId);
    const record = await this.authority.create(
      {
        sessionId,
        projectPath,
        title: conversation.title,
        text,
        attachments,
        ...(conversation.configuration ? { configuration: conversation.configuration } : null),
        labelIds: [...conversation.labelIds],
      },
      { signal: this.signal },
    );
    this.relocate(sessionId, projectPath);
    this.applySavedRecord(record);
    removeValue(this.stagedSessionIds, sessionId);
  }

  async updateSavedMetadata(
    sessionId: string,
    changes: Partial<Pick<SavedDraft, "title" | "resolved" | "labelIds">>,
  ) {
    const record = this.savedRecords[sessionId];
    if (record?.status !== "saved") throw new Error("Cake could not find that saved Draft");
    try {
      const updated = await this.authority.update({ ...record, ...changes }, record.revision, {
        signal: this.signal,
      });
      this.applySavedRecord(updated);
    } catch (error) {
      await this.refreshSavedDrafts();
      throw error;
    }
  }

  async updateDraft(sessionId: string, text: string, attachments: Attachment[]) {
    const record = this.savedRecords[sessionId];
    if (!record) throw new Error("Cake could not find that saved Draft");
    const updated = await this.authority.update({ ...record, text, attachments }, record.revision, {
      signal: this.signal,
    });
    this.applySavedRecord(updated);
  }

  savedRecord(sessionId: string) {
    return this.savedRecords[sessionId];
  }

  markActivated(record: SavedDraft) {
    this.savedRecords[record.sessionId] = record;
  }

  async recoverUncertain(sessionId: string) {
    const record = this.savedRecords[sessionId];
    if (record?.status !== "activating") return;
    const recovered = await this.authority.recoverUncertain(sessionId, record.revision, {
      signal: this.signal,
    });
    this.applySavedRecord(recovered);
  }

  async refreshSavedDrafts() {
    if (!this.props.savedDrafts) return;
    const revision = ++this.loadRevision;
    const records = await this.authority.list({ signal: this.signal });
    if (this.signal.aborted || revision !== this.loadRevision) return;
    this.applySavedDraftSnapshot(records);
  }

  applySavedDraftSnapshot(records: ReadonlyArray<SavedDraft>) {
    // In-flight list requests cannot overwrite a newer pushed snapshot.
    ++this.loadRevision;
    batch(() => {
      for (const record of records) {
        const existing = this.savedRecords[record.sessionId];
        if (existing && existing.revision > record.revision) continue;
        this.applySavedRecord(record);
      }
      const ids = new Set(records.map((record) => record.sessionId));
      for (const id of Object.keys(this.savedRecords)) if (!ids.has(id)) this.removeSavedRecord(id);
    });
  }

  private get authority() {
    if (!this.props.savedDrafts) throw new Error("Saved Draft authority is unavailable");
    return this.props.savedDrafts;
  }

  private applySavedRecord(record: SavedDraft) {
    this.savedRecords[record.sessionId] = record;
    if (record.status === "activated") {
      if (this.isTemporary(record.sessionId))
        this.materialize(record.sessionId, record.workingDirectory);
      return;
    }
    if (!this.props.session(record.sessionId)) this.prepare(record.projectPath, record.sessionId);
    const conversation = this.ensureConversation(record.sessionId);
    conversation.name = record.title;
    conversation.draftPrompt = {
      text: record.text,
      attachments: [...record.attachments],
      resolved: record.resolved,
    };
    conversation.configuration = record.configuration;
    conversation.labelIds = record.labelIds;
    conversation.createdAt = record.createdAt;
    conversation.modifiedAt = record.modifiedAt;
  }

  private removeSavedRecord(sessionId: string) {
    delete this.savedRecords[sessionId];
    if (this.isTemporary(sessionId)) this.props.removeSession(sessionId);
  }

  async setLabels(sessionId: string, labelIds: readonly string[]) {
    const conversation = this.conversation(sessionId);
    if (!conversation || !this.isTemporary(sessionId))
      throw new Error("Cake could not find that pending session");
    conversation.setLabels(labelIds);
    await this.props.persistNow();
  }

  async deleteResolvedDraft(sessionId: string) {
    const record = this.savedRecords[sessionId];
    if (!record?.resolved) return false;
    await this.authority.remove(sessionId, record.revision, { signal: this.signal });
    this.removeSavedRecord(sessionId);
    return true;
  }

  relocate(sessionId: string, workingDirectory: string) {
    if (!this.temporarySessionIds.includes(sessionId))
      throw new Error("Only an unsent session can choose another worktree.");
    const session = this.props.session(sessionId);
    if (!session) throw new Error("Cake could not find that draft session.");
    if (session.workspacePath === workingDirectory) return;
    this.props.relocateIdentity(sessionId, workingDirectory);
    void session.stagedCommandStore.load(workingDirectory);
    if (this.isDraft(sessionId)) this.conversation(sessionId)?.touch();
  }

  remove(sessionId: string) {
    removeValue(this.temporarySessionIds, sessionId);
    removeValue(this.stagedSessionIds, sessionId);
    removeValue(this.unlistedNewSessionIds, sessionId);
    removeValue(this.conversationIds, sessionId);
    delete this.summaryMetadataBySession[sessionId];
    removeValue(this.submittingSessionIds, sessionId);
  }

  private ensureConversation(sessionId: string) {
    addUnique(this.conversationIds, sessionId);
    return this.conversation(sessionId)!;
  }

  private clearSummary(sessionId: string) {
    removeValue(this.unlistedNewSessionIds, sessionId);
    removeValue(this.conversationIds, sessionId);
    delete this.summaryMetadataBySession[sessionId];
  }

  private reconcileAuthoritativeSessions(sessionIds: readonly string[]) {
    const authoritative = new Set(sessionIds);
    for (let index = this.unlistedNewSessionIds.length - 1; index >= 0; index -= 1) {
      const sessionId = this.unlistedNewSessionIds[index]!;
      if (authoritative.has(sessionId)) this.clearSummary(sessionId);
    }
  }

  constructor(props: ProjectPendingSessionsStore["props"]) {
    super(props);
    this.reaction(
      () => this.props.catalog?.authoritativeSessionIds ?? [],
      (sessionIds) => {
        this.reconcileAuthoritativeSessions(sessionIds);
        untracked(() => void this.refreshSavedDrafts());
      },
    );
    this.effect(() => untracked(() => void this.refreshSavedDrafts()));
  }
}

function addUnique(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

function removeValue(values: string[], value: string) {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}
