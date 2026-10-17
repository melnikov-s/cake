import { Store, batch, child, computed, createStore, observable, snapshot } from "r-state-tree";
import {
  SESSION_TITLE_MAX_LENGTH,
  type Attachment,
  type ChatConfiguration,
} from "../../contracts/conversations/session-contract";
import type { ProjectSessionStore } from "./ProjectSessionStore";
import type { SavedDraft } from "../../contracts/project-sessions/saved-draft-data";
import type { Client } from "../client/Client";
import type { SessionCatalogStore, PendingSessionSummary } from "./SessionCatalogStore";
import { PendingConversationStore } from "./PendingConversationStore";
import { ClientContext } from "./context/ClientContext";

export type SavedDraftClient = Client["savedDrafts"];

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

type UnlistedSummary = Pick<
  PendingSessionSummary,
  "title" | "createdAt" | "modifiedAt" | "messageCount" | "resolved"
>;
type PendingSessionPhase =
  | { phase: "prepared" | "staged" | "submitting" }
  // Pi may take time to include a newly started session in its disk-backed listing.
  | { phase: "unlisted"; summary: UnlistedSummary };

/** Owns window-persisted unsaved workflows and the shared Saved Draft projection. */
export class ProjectPendingSessionsStore extends Store<ProjectPendingSessionsStoreProps> {
  @snapshot private readonly lifecycleVersion = 1;
  @snapshot private readonly sessionsById: Record<string, PendingSessionPhase> = observable({});
  @snapshot private readonly summaryMetadataBySession: Record<
    string,
    ProjectPendingSummaryMetadata
  > = observable({});
  private readonly savedRecords: Record<string, SavedDraft> = observable({});
  private loadRevision = 0;

  private get conversationIds() {
    return Object.keys(this.sessionsById).filter(
      (id) => this.sessionsById[id]?.phase !== "unlisted",
    );
  }

  @child
  get conversations(): PendingConversationStore[] {
    return this.conversationIds.map((sessionId) =>
      createStore(PendingConversationStore, { key: sessionId, sessionId }),
    );
  }

  @computed
  private get conversationsById(): ReadonlyMap<string, PendingConversationStore> {
    // Track membership directly so lookup also sees changes inside a batch,
    // before child-Store listeners flush.
    const ids = this.conversationIds;
    const conversations = this.conversations;
    return new Map(ids.map((sessionId, index) => [sessionId, conversations[index]!]));
  }

  conversation(sessionId: string) {
    return this.conversationsById.get(sessionId);
  }

  get summaries(): readonly PendingSessionSummary[] {
    const visibleIds = new Set([
      ...Object.keys(this.savedRecords).filter(
        (id) => this.savedRecords[id]?.status !== "activated",
      ),
      ...Object.keys(this.sessionsById).filter((id) => {
        const phase = this.sessionsById[id]?.phase;
        return phase === "submitting" || phase === "unlisted";
      }),
    ]);
    return [...visibleIds].flatMap((sessionId) => {
      const session = this.props.session(sessionId);
      const record = this.savedRecords[sessionId];
      const entry = this.sessionsById[sessionId];
      const saved = record && record.status !== "activated" ? record : undefined;
      const facts =
        saved ?? (entry?.phase === "unlisted" ? entry.summary : this.conversation(sessionId));
      if (!session || !facts) return [];
      const metadata = this.summaryMetadataBySession[sessionId];
      const projectPath =
        record?.projectPath ??
        this.props.catalog?.projectPathFor(session.workspacePath) ??
        session.workspacePath;
      return [
        {
          sessionId,
          title: facts.title,
          createdAt: facts.createdAt,
          modifiedAt: facts.modifiedAt,
          messageCount: saved ? 0 : "messageCount" in facts ? facts.messageCount : 0,
          resolved: facts.resolved,
          unread: false,
          running: false,
          projectPath,
          projectName: this.props.projectName(projectPath),
          workingDirectory: session.workspacePath,
          ...metadata,
          pending: true as const,
          draft: saved !== undefined,
        },
      ];
    });
  }

  prepare(workingDirectory: string, sessionId: string) {
    const session = this.props.prepareIdentity(sessionId, workingDirectory);
    if (!this.sessionsById[sessionId] && !this.savedRecords[sessionId]) {
      this.sessionsById[sessionId] = { phase: "prepared" };
      this.conversation(sessionId);
    }
    return session;
  }

  prepareStaged(workingDirectory: string, sessionId: string) {
    const session = this.prepare(workingDirectory, sessionId);
    if (this.sessionsById[sessionId]?.phase === "prepared")
      this.sessionsById[sessionId] = { phase: "staged" };
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
    const now = new Date().toISOString();
    this.sessionsById[sessionId] = {
      phase: "unlisted",
      summary: { title, createdAt: now, modifiedAt: now, messageCount: 0, resolved: false },
    };
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
  }

  /** Pi title events remain authoritative while a started session awaits catalog registration. */
  applyLiveTitle(sessionId: string, title: string) {
    const entry = this.sessionsById[sessionId];
    if (entry?.phase === "unlisted" && entry.summary)
      this.sessionsById[sessionId] = {
        ...entry,
        summary: { ...entry.summary, title, modifiedAt: new Date().toISOString() },
      };
    else if (!this.savedRecords[sessionId]) this.conversation(sessionId)?.setName(title);
  }

  materialize(sessionId: string, workingDirectory: string) {
    if (!this.isTemporary(sessionId))
      throw new Error("Only a successfully started renderer draft can be materialized.");
    return batch(() => {
      this.props.session(sessionId)?.stagedCommandStore.invalidate();
      const session = this.props.materializeIdentity(sessionId, workingDirectory);
      const facts = this.conversation(sessionId) ?? this.savedRecords[sessionId]!;
      // Once started, this is only a temporary Pi catalog summary, never pending
      // conversation data or a second writable representation of a saved Draft.
      this.sessionsById[sessionId] = {
        phase: "unlisted",
        summary: {
          title: facts.title,
          createdAt: facts.createdAt,
          modifiedAt: new Date().toISOString(),
          messageCount: "messageCount" in facts ? Math.max(1, facts.messageCount) : 1,
          resolved: false,
        },
      };
      if (this.props.catalog?.authoritativeSessionIds.includes(sessionId))
        this.clearSummary(sessionId);
      return session;
    });
  }

  projectSubmission(sessionId: string, text: string) {
    if (!this.conversation(sessionId) || !this.props.session(sessionId)) return;
    const conversation = this.conversation(sessionId)!;
    const title = text.trim().slice(0, SESSION_TITLE_MAX_LENGTH) || "New chat";
    batch(() => {
      this.sessionsById[sessionId] = { phase: "submitting" };
      conversation.setFallbackTitle(title);
      conversation.messageCount = Math.max(1, conversation.messageCount);
    });
  }

  cancelSubmission(sessionId: string) {
    if (this.sessionsById[sessionId]?.phase === "submitting")
      this.sessionsById[sessionId] = { phase: "staged" };
  }

  isStaged(sessionId: string) {
    return this.sessionsById[sessionId]?.phase === "staged";
  }

  /** A renderer-known identity whose transcript may not exist yet. */
  canCreateRuntime(sessionId: string) {
    return this.isTemporary(sessionId) || this.sessionsById[sessionId]?.phase === "unlisted";
  }

  isTemporary(sessionId: string) {
    const entry = this.sessionsById[sessionId];
    if (entry) return entry.phase !== "unlisted";
    const saved = this.savedRecords[sessionId];
    return saved !== undefined && saved.status !== "activated";
  }

  isDraft(sessionId: string) {
    return this.savedRecords[sessionId]?.status === "saved";
  }

  async setConfiguration(sessionId: string, configuration: ChatConfiguration) {
    if (this.savedRecords[sessionId]) await this.updateSavedMetadata(sessionId, { configuration });
    else this.conversation(sessionId)?.setConfiguration(configuration);
  }

  async createDraft(sessionId: string, text: string, attachments: Attachment[]) {
    const conversation = this.conversation(sessionId);
    if (!conversation || !this.isTemporary(sessionId))
      throw new Error("Only a new session can be saved as a draft");
    const session = this.props.session(sessionId);
    if (!session) throw new Error("Cake could not find that new session");
    const projectPath =
      this.props.catalog?.projectPathFor(session.workspacePath) ?? session.workspacePath;
    const automaticTitle = !conversation.name && Boolean(text.trim());
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
    if (this.signal.aborted) return;
    this.relocate(sessionId, projectPath);
    this.applySavedRecord(record);
    if (automaticTitle)
      void ClientContext.consume(this)!
        .workspaces.generateSessionTitle(text, { signal: this.signal })
        .then(async (title) => {
          const current = this.savedRecords[sessionId];
          // Never overwrite a manual rename, edited prompt, or activation while naming ran.
          if (
            !title?.trim() ||
            this.signal.aborted ||
            current?.status !== "saved" ||
            current.revision !== record.revision
          )
            return;
          await this.updateSavedMetadata(sessionId, {
            title: title.trim().slice(0, SESSION_TITLE_MAX_LENGTH),
          });
        })
        // Naming is advisory: a failed request or revision conflict must not undo saving.
        .catch(() => undefined);
  }

  async updateSavedMetadata(
    sessionId: string,
    changes: Partial<Pick<SavedDraft, "title" | "resolved" | "labelIds" | "configuration">>,
  ) {
    const record = this.savedRecords[sessionId];
    if (record?.status !== "saved") throw new Error("Cake could not find that saved Draft");
    try {
      const updated = await this.authority.update({ ...record, ...changes }, record.revision, {
        signal: this.signal,
      });
      if (!this.signal.aborted) this.applySavedRecord(updated);
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
    if (!this.signal.aborted) this.applySavedRecord(updated);
  }

  savedRecord(sessionId: string) {
    return this.savedRecords[sessionId];
  }

  markActivated(record: SavedDraft) {
    this.applySavedRecord(record);
  }

  async recoverUncertain(sessionId: string) {
    const record = this.savedRecords[sessionId];
    if (record?.status !== "activating") return;
    const recovered = await this.authority.recoverUncertain(sessionId, record.revision, {
      signal: this.signal,
    });
    if (!this.signal.aborted) this.applySavedRecord(recovered);
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
      for (const record of records) this.applySavedRecord(record);
      const ids = new Set(records.map((record) => record.sessionId));
      for (const id of Object.keys(this.savedRecords)) if (!ids.has(id)) this.removeSavedRecord(id);
    });
  }

  private get authority() {
    if (!this.props.savedDrafts) throw new Error("Saved Draft authority is unavailable");
    return this.props.savedDrafts;
  }

  private applySavedRecord(record: SavedDraft) {
    const existing = this.savedRecords[record.sessionId];
    if (existing && existing.revision > record.revision) return;
    batch(() => {
      if (record.status === "activated") {
        if (this.isTemporary(record.sessionId))
          this.materialize(record.sessionId, record.workingDirectory);
        this.savedRecords[record.sessionId] = record;
        return;
      }
      this.savedRecords[record.sessionId] = record;
      if (!this.props.session(record.sessionId))
        this.props.prepareIdentity(record.sessionId, record.projectPath);
      // Saving transfers facts to the shared authority, disposing only unsaved data,
      // not the stable ProjectSessionStore or its composer/pane presentation.
      delete this.sessionsById[record.sessionId];
    });
  }

  private removeSavedRecord(sessionId: string) {
    const temporary = this.isTemporary(sessionId);
    delete this.savedRecords[sessionId];
    if (temporary) this.props.removeSession(sessionId);
  }

  async setLabels(sessionId: string, labelIds: readonly string[]) {
    if (this.isDraft(sessionId)) {
      await this.updateSavedMetadata(sessionId, { labelIds: [...new Set(labelIds)] });
      return;
    }
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
    if (!this.isTemporary(sessionId))
      throw new Error("Only an unsent session can choose another worktree.");
    const session = this.props.session(sessionId);
    if (!session) throw new Error("Cake could not find that draft session.");
    if (session.workspacePath === workingDirectory) return;
    this.props.relocateIdentity(sessionId, workingDirectory);
    void session.stagedCommandStore.load(workingDirectory);
  }

  remove(sessionId: string) {
    delete this.sessionsById[sessionId];
    delete this.summaryMetadataBySession[sessionId];
  }

  private clearSummary(sessionId: string) {
    delete this.sessionsById[sessionId];
    delete this.summaryMetadataBySession[sessionId];
  }

  private reconcileAuthoritativeSessions(sessionIds: readonly string[]) {
    for (const sessionId of sessionIds)
      if (this.sessionsById[sessionId]?.phase === "unlisted") this.clearSummary(sessionId);
  }

  constructor(props: ProjectPendingSessionsStore["props"]) {
    super(props);
    this.reaction(
      () => this.props.catalog?.authoritativeSessionIds ?? [],
      (sessionIds) => this.reconcileAuthoritativeSessions(sessionIds),
    );
  }
}
