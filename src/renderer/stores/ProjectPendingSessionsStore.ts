import { Store, batch, observable, snapshot } from "r-state-tree";
import {
  SESSION_TITLE_MAX_LENGTH,
  type Attachment,
  type ChatConfiguration,
} from "../../ipc/session-contract";
import type { ProjectSessionStore } from "./ProjectSessionStore";
import type { SessionCatalogStore, PendingSessionSummary } from "./SessionCatalogStore";

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

/** Owns window-persisted staged, saved-draft, and starting Project Session workflows. */
export class ProjectPendingSessionsStore extends Store<ProjectPendingSessionsStoreProps> {
  // Pi may take time to include a newly started session in its disk-backed listing.
  @snapshot private readonly unlistedNewSessionIds: string[] = observable([]);
  @snapshot private readonly configurationsBySession: Record<string, ChatConfiguration> =
    observable({});
  @snapshot private readonly namesBySession: Record<string, string> = observable({});
  @snapshot private readonly draftsBySession: Record<
    string,
    { text: string; attachments: Attachment[]; resolved: boolean }
  > = observable({});
  @snapshot private readonly temporarySessionIds: string[] = observable([]);
  @snapshot private readonly summaryMetadataBySession: Record<
    string,
    {
      fallbackTitle?: string;
      createdAt: string;
      modifiedAt: string;
      familyId?: string;
      familyParentSessionId?: string;
      familyChildOrder?: number;
    }
  > = observable({});
  /** Unsent, unsaved project chats retained by independent session panes. */
  @snapshot private readonly stagedSessionIds: string[] = observable([]);
  private readonly submittingSessionIds: string[] = observable([]);

  get summaries(): readonly PendingSessionSummary[] {
    const visibleIds = new Set([
      ...Object.keys(this.draftsBySession),
      ...this.submittingSessionIds,
      ...this.unlistedNewSessionIds,
    ]);
    return [...visibleIds].flatMap((sessionId) => {
      const session = this.props.session(sessionId);
      if (!session) return [];
      const draft = this.draftsBySession[sessionId];
      const metadata = this.summaryMetadataBySession[sessionId];
      const managedWorktree = this.props.catalog?.managedWorktree(session.workspacePath);
      const projectPath = managedWorktree?.projectPath ?? session.workspacePath;
      const epoch = "1970-01-01T00:00:00.000Z";
      return [
        {
          sessionId,
          title: this.namesBySession[sessionId] ?? metadata?.fallbackTitle ?? "New chat",
          createdAt: metadata?.createdAt ?? epoch,
          modifiedAt: metadata?.modifiedAt ?? epoch,
          messageCount: draft ? 0 : 1,
          resolved: draft?.resolved ?? false,
          unread: false,
          projectPath,
          projectName: this.props.projectName(projectPath),
          workingDirectory: session.workspacePath,
          managedWorktree,
          ...(metadata?.familyId !== undefined ? { familyId: metadata.familyId } : null),
          ...(metadata?.familyParentSessionId !== undefined
            ? { familyParentSessionId: metadata.familyParentSessionId }
            : null),
          ...(metadata?.familyChildOrder !== undefined
            ? { familyChildOrder: metadata.familyChildOrder }
            : null),
          pending: true as const,
          draft: draft !== undefined,
        },
      ];
    });
  }

  prepare(workingDirectory: string, sessionId: string) {
    const session = this.props.prepareIdentity(sessionId, workingDirectory);
    addUnique(this.temporarySessionIds, sessionId);
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
    const now = new Date().toISOString();
    const current = this.summaryMetadataBySession[sessionId];
    this.namesBySession[sessionId] = title;
    this.summaryMetadataBySession[sessionId] = {
      createdAt: current?.createdAt ?? now,
      modifiedAt: now,
      fallbackTitle: title,
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
      delete this.configurationsBySession[sessionId];
      delete this.draftsBySession[sessionId];
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
    this.updateSummaryMetadata(sessionId, title);
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
    return this.draftsBySession[sessionId] !== undefined;
  }

  draftPrompt(sessionId: string) {
    return this.draftsBySession[sessionId];
  }

  async createDraft(sessionId: string, text: string, attachments: Attachment[]) {
    if (!this.temporarySessionIds.includes(sessionId))
      throw new Error("Only a new session can be saved as a draft");
    const session = this.props.session(sessionId)!;
    const projectPath =
      this.props.catalog?.projectOfManagedWorktree(session.workspacePath) ?? session.workspacePath;
    this.relocate(sessionId, projectPath);
    this.draftsBySession[sessionId] = {
      text,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      resolved: false,
    };
    this.ensureSummaryMetadata(sessionId);
    removeValue(this.stagedSessionIds, sessionId);
    await this.props.persistNow();
  }

  async updateDraft(sessionId: string, text: string, attachments: Attachment[]) {
    const current = this.draftsBySession[sessionId];
    if (!current) throw new Error("Cake could not find that draft session");
    this.draftsBySession[sessionId] = {
      text,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      resolved: current.resolved,
    };
    await this.props.persistNow();
  }

  activateDraft(sessionId: string) {
    const current = this.draftsBySession[sessionId];
    if (!current) return undefined;
    delete this.draftsBySession[sessionId];
    this.touchSummary(sessionId);
    return current;
  }

  setDraftResolved(sessionId: string, resolved: boolean) {
    const current = this.draftsBySession[sessionId];
    if (!current) return false;
    this.draftsBySession[sessionId] = { ...current, resolved };
    this.touchSummary(sessionId);
    return true;
  }

  async deleteResolvedDraft(sessionId: string) {
    if (!this.draftsBySession[sessionId]?.resolved) return false;
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
    if (this.isDraft(sessionId)) this.touchSummary(sessionId);
  }

  configuration(sessionId: string) {
    return this.configurationsBySession[sessionId];
  }

  name(sessionId: string) {
    return this.namesBySession[sessionId];
  }

  setName(sessionId: string, name: string) {
    if (!this.temporarySessionIds.includes(sessionId))
      throw new Error("Only an unsent session can receive an initial name.");
    this.namesBySession[sessionId] = name.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
    this.touchSummary(sessionId);
  }

  applyGeneratedDraftName(sessionId: string, name: string) {
    if (!this.isDraft(sessionId) || this.namesBySession[sessionId]) return;
    this.setName(sessionId, name);
  }

  setConfiguration(sessionId: string, configuration: ChatConfiguration) {
    this.configurationsBySession[sessionId] = configuration;
  }

  remove(sessionId: string) {
    removeValue(this.temporarySessionIds, sessionId);
    removeValue(this.stagedSessionIds, sessionId);
    removeValue(this.unlistedNewSessionIds, sessionId);
    delete this.configurationsBySession[sessionId];
    delete this.namesBySession[sessionId];
    delete this.draftsBySession[sessionId];
    delete this.summaryMetadataBySession[sessionId];
    removeValue(this.submittingSessionIds, sessionId);
  }

  private ensureSummaryMetadata(sessionId: string) {
    if (this.summaryMetadataBySession[sessionId]) return;
    const now = new Date().toISOString();
    this.summaryMetadataBySession[sessionId] = { createdAt: now, modifiedAt: now };
  }

  private updateSummaryMetadata(sessionId: string, fallbackTitle?: string) {
    const current = this.summaryMetadataBySession[sessionId];
    const now = new Date().toISOString();
    this.summaryMetadataBySession[sessionId] = {
      ...current,
      createdAt: current?.createdAt ?? now,
      modifiedAt: now,
      fallbackTitle: fallbackTitle ?? current?.fallbackTitle,
    };
  }

  private touchSummary(sessionId: string) {
    this.updateSummaryMetadata(sessionId);
  }

  private clearSummary(sessionId: string) {
    removeValue(this.unlistedNewSessionIds, sessionId);
    delete this.namesBySession[sessionId];
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
