import { Store, batch, child, createStore, observable, snapshot } from "r-state-tree";
import { SESSION_TITLE_MAX_LENGTH, type Attachment } from "../../ipc/session-contract";
import type { ProjectSessionStore } from "./ProjectSessionStore";
import type { SessionCatalogStore, PendingSessionSummary } from "./SessionCatalogStore";
import { PendingConversationStore } from "./PendingConversationStore";

export interface ProjectPendingSessionsStoreProps {
  catalog?: SessionCatalogStore;
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
  familyChildOrder?: number;
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

  trackUnlistedFamilySession(
    sessionId: string,
    title: string,
    family: { familyId: string; parentSessionId: string; childOrder: number },
  ) {
    const conversation = this.ensureConversation(sessionId);
    conversation.setName(title);
    conversation.fallbackTitle = title;
    this.summaryMetadataBySession[sessionId] = {
      familyId: family.familyId,
      familyParentSessionId: family.parentSessionId,
      familyChildOrder: family.childOrder,
    };
    addUnique(this.unlistedNewSessionIds, sessionId);
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
    const conversation = this.ensureConversation(sessionId);
    conversation.setFallbackTitle(title);
    conversation.messageCount = Math.max(1, conversation.messageCount);
  }

  cancelSubmission(sessionId: string) {
    removeValue(this.submittingSessionIds, sessionId);
  }

  isStaged(sessionId: string) {
    return this.stagedSessionIds.includes(sessionId);
  }

  isTemporary(sessionId: string) {
    return this.temporarySessionIds.includes(sessionId);
  }

  isDraft(sessionId: string) {
    return this.conversation(sessionId)?.isDraft ?? false;
  }

  async createDraft(sessionId: string, text: string, attachments: Attachment[]) {
    if (!this.temporarySessionIds.includes(sessionId))
      throw new Error("Only a new session can be saved as a draft");
    const session = this.props.session(sessionId)!;
    const projectPath =
      this.props.catalog?.projectOfManagedWorktree(session.workspacePath) ?? session.workspacePath;
    this.relocate(sessionId, projectPath);
    this.ensureConversation(sessionId).createDraft(text, attachments);
    removeValue(this.stagedSessionIds, sessionId);
    await this.props.persistNow();
  }

  async updateDraft(sessionId: string, text: string, attachments: Attachment[]) {
    const conversation = this.conversation(sessionId);
    if (!conversation?.updateDraft(text, attachments))
      throw new Error("Cake could not find that draft session");
    await this.props.persistNow();
  }

  async deleteResolvedDraft(sessionId: string) {
    if (!this.conversation(sessionId)?.resolved) return false;
    this.props.removeSession(sessionId);
    await this.props.persistNow();
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
      (sessionIds) => this.reconcileAuthoritativeSessions(sessionIds),
    );
  }
}

function addUnique(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

function removeValue(values: string[], value: string) {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}
