import { Store, batch, child, createStore, observable, snapshot, updateStore } from "r-state-tree";
import {
  SESSION_TITLE_MAX_LENGTH,
  type Attachment,
  type ChatConfiguration,
  type ModelPreset,
} from "../../ipc/session-contract";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { PendingSessionSummary } from "./SessionCatalogStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { ProjectSessionStore, type SessionTarget } from "./ProjectSessionStore";
import type { WorktreeStoreProps } from "./WorktreeStore";
import type { ExistingWorktreeCandidate, WorktreeDraftChoice } from "./WorktreeCreationStore";
import type { Session } from "../models/Session";

const IDLE_OBSERVATION_LIMIT = 20;

export interface SessionRegistryStoreProps {
  catalog?: SessionCatalogStore;
  sessionModel(sessionId: string, workingDirectory: string): Session;
  operations: SessionOperationCoordinatorStore;
  reviews(): ReviewsStore;
  canSubmit(sessionId: string): boolean;
  isActive(sessionId: string): boolean;
  openCommandPane(pane: "changelog" | "tree" | "resources"): Promise<void>;
  persistNow(): Promise<void>;
  projectName(workspacePath: string): string;
  abort(): Promise<void>;
  renameSession(sessionId: string, name: string): Promise<void>;
  handoffSession(entryId: string, prompt?: string, resolveSource?: boolean): Promise<boolean>;
  modelPresets?(): readonly ModelPreset[];
  openModelPresetSettings?(): void;
  newSessionRequest?(
    sessionId: string,
  ): { path: string; configuration?: ChatConfiguration; name?: string } | undefined;
  prepareNewSession?(sessionId: string, firstUserMessage: string): Promise<boolean>;
  configureDraftActivation?(sessionId: string, choice: WorktreeDraftChoice): void;
  sessionCreationChoice?(sessionId: string): WorktreeDraftChoice;
  draftActivationCandidates?(sessionId: string): ExistingWorktreeCandidate[];
  onWorktreeLanded: WorktreeStoreProps["onLanded"];
  onWorktreeDiscarded: WorktreeStoreProps["onDiscarded"];
  onResolveWorktree: WorktreeStoreProps["onResolveWorkspace"];
  settings?(): AppearanceSettingsStore | undefined;
}

/** Owns the keyed collection of loaded per-session Store instances for a window. */
export class SessionRegistryStore extends Store<SessionRegistryStoreProps> {
  @snapshot readonly targets: SessionTarget[] = observable([]);
  // Pi may take time to include a newly started session in its disk-backed listing.
  // Retain all such sessions independently from unsent renderer-owned sessions.
  @snapshot private readonly unlistedNewSessionIds: string[] = observable([]);
  @snapshot private readonly materializedSessionIds: string[] = observable([]);
  // A deferred new session has no runtime yet, so configuration changes are kept
  // locally and delivered with the first prompt instead of runtime commands.
  @snapshot private readonly pendingConfigurationsBySession: Record<string, ChatConfiguration> =
    observable({});
  @snapshot private readonly pendingNamesBySession: Record<string, string> = observable({});
  @snapshot private readonly draftSessionsById: Record<
    string,
    { text: string; attachments: Attachment[]; resolved: boolean }
  > = observable({});
  @snapshot private readonly temporarySessionIds: string[] = observable([]);
  @snapshot private readonly pendingSummaryMetadataBySession: Record<
    string,
    { fallbackTitle?: string; createdAt: string; modifiedAt: string }
  > = observable({});
  /** The one unsent, unsaved project chat. Explicit drafts are not staged chats. */
  @snapshot private stagedSessionId: string | undefined;
  private readonly sessionsById = new Map<string, ProjectSessionStore>();
  private readonly submittingSessionIds: string[] = observable([]);
  /** Process-local LRU. Selected and running sessions are pinned outside this idle budget. */
  private readonly recentObservationSessionIds: string[] = observable([]);

  @child
  get sessions(): ProjectSessionStore[] {
    return this.targets.map((target) =>
      createStore(ProjectSessionStore, {
        key: target.sessionId,
        ...target,
        model: this.props.sessionModel(target.sessionId, target.workspacePath),
        registry: this,
        operations: this.props.operations,
        reviews: this.props.reviews,
        canSubmit: () => this.props.canSubmit(target.sessionId),
        isActive: () => this.props.isActive(target.sessionId),
        openCommandPane: (pane) => this.props.openCommandPane(pane),
        projectName: () => this.props.projectName(target.workspacePath),
        abort: () => this.props.abort(),
        renameSession: (name) => this.props.renameSession(target.sessionId, name),
        handoffSession: (entryId, prompt, resolveSource) =>
          this.props.handoffSession(entryId, prompt, resolveSource),
        modelPresets: () => this.props.modelPresets?.() ?? [],
        openModelPresetSettings: () => this.props.openModelPresetSettings?.(),
        newSessionRequest: () => this.props.newSessionRequest?.(target.sessionId),
        prepareNewSession: (firstUserMessage) =>
          this.props.prepareNewSession?.(target.sessionId, firstUserMessage) ??
          Promise.resolve(true),
        configureDraftActivation: (choice) =>
          this.props.configureDraftActivation?.(target.sessionId, choice),
        sessionCreationChoice: () =>
          this.props.sessionCreationChoice?.(target.sessionId) ?? { kind: "current" },
        draftActivationCandidates: () =>
          this.props.draftActivationCandidates?.(target.sessionId) ?? [],
        onWorktreeLanded: this.props.onWorktreeLanded,
        onWorktreeDiscarded: this.props.onWorktreeDiscarded,
        onResolveWorktree: this.props.onResolveWorktree,
        settings: () => this.props.settings?.(),
      }),
    );
  }

  findModel(sessionId: string) {
    return this.findSession(sessionId)?.model;
  }

  findSession(sessionId: string) {
    const cached = this.sessionsById.get(sessionId);
    if (cached) return cached;
    const session = this.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (session) this.sessionsById.set(sessionId, session);
    return session;
  }

  load(sessionId: string, workingDirectory: string) {
    this.rememberSessionLocation(sessionId, workingDirectory);
    const session = this.addTarget(sessionId, workingDirectory);
    addUnique(this.materializedSessionIds, sessionId);
    this.retainObservation(sessionId);
    return session;
  }

  /** Project Sessions whose transcript projections should remain synchronized. */
  get observationSessions() {
    const recent = new Set(this.recentObservationSessionIds);
    return this.sessions.filter(
      (session) =>
        this.isObservableSession(session) &&
        (recent.has(session.sessionId) ||
          this.props.isActive(session.sessionId) ||
          this.isRunning(session)),
    );
  }

  /** Marks a user-visible or newly started session as most recently used. */
  retainObservation(sessionId: string) {
    if (!this.materializedSessionIds.includes(sessionId)) return;
    this.touchObservationLru(sessionId);
    this.trimObservationLru();
  }

  get pendingSummaries(): readonly PendingSessionSummary[] {
    const visibleIds = new Set([
      ...Object.keys(this.draftSessionsById),
      ...this.submittingSessionIds,
      ...this.unlistedNewSessionIds,
    ]);
    return [...visibleIds].flatMap((sessionId) => {
      const target = this.targets.find((candidate) => candidate.sessionId === sessionId);
      if (!target) return [];
      const draft = this.draftSessionsById[sessionId];
      const metadata = this.pendingSummaryMetadataBySession[sessionId];
      const managedWorktree = this.props.catalog?.managedWorktree(target.workspacePath);
      const projectPath = managedWorktree?.projectPath ?? target.workspacePath;
      const epoch = "1970-01-01T00:00:00.000Z";
      return [
        {
          sessionId,
          title: this.pendingNamesBySession[sessionId] ?? metadata?.fallbackTitle ?? "New chat",
          createdAt: metadata?.createdAt ?? epoch,
          modifiedAt: metadata?.modifiedAt ?? epoch,
          messageCount: draft ? 0 : 1,
          resolved: draft?.resolved ?? false,
          unread: false,
          projectPath,
          projectName: this.props.projectName(projectPath),
          workingDirectory: target.workspacePath,
          managedWorktree,
          pending: true as const,
          draft: draft !== undefined,
        },
      ];
    });
  }

  /** Atomically transitions one successfully started renderer draft into an observed Pi Session. */
  materializeNewSession(sessionId: string, workingDirectory: string) {
    if (!this.temporarySessionIds.includes(sessionId))
      throw new Error("Only a successfully started renderer draft can be materialized.");
    return batch(() => {
      this.findSession(sessionId)?.stagedCommandStore.invalidate();
      this.rememberSessionLocation(sessionId, workingDirectory);
      const session = this.addTarget(sessionId, workingDirectory);
      addUnique(this.materializedSessionIds, sessionId);
      this.retainObservation(sessionId);
      removeValue(this.temporarySessionIds, sessionId);
      removeValue(this.submittingSessionIds, sessionId);
      if (this.stagedSessionId === sessionId) this.stagedSessionId = undefined;
      delete this.pendingConfigurationsBySession[sessionId];
      delete this.draftSessionsById[sessionId];
      addUnique(this.unlistedNewSessionIds, sessionId);
      return session;
    });
  }

  /** Publishes the first-message projection before Pi creates its authoritative session. */
  projectNewSessionSubmission(sessionId: string, text: string) {
    if (!this.temporarySessionIds.includes(sessionId)) return;
    if (!this.targets.some((target) => target.sessionId === sessionId)) return;
    const title = text.trim().slice(0, SESSION_TITLE_MAX_LENGTH) || "New chat";
    addUnique(this.submittingSessionIds, sessionId);
    this.updatePendingSummaryMetadata(sessionId, title);
  }

  cancelNewSessionSubmission(sessionId: string) {
    removeValue(this.submittingSessionIds, sessionId);
  }

  prepareNewSession(workspacePath: string, sessionId: string) {
    this.rememberSessionLocation(sessionId, workspacePath);
    const session = this.addTarget(sessionId, workspacePath);
    addUnique(this.temporarySessionIds, sessionId);
    return session;
  }

  /** Returns the window's existing staged chat instead of creating a second one. */
  prepareStagedSession(workspacePath: string, sessionId: string) {
    if (this.stagedSessionId) {
      const staged = this.findSession(this.stagedSessionId);
      if (staged) return staged;
      this.stagedSessionId = undefined;
    }
    const session = this.prepareNewSession(workspacePath, sessionId);
    this.stagedSessionId = sessionId;
    return session;
  }

  stagedSession() {
    return this.stagedSessionId ? this.findSession(this.stagedSessionId) : undefined;
  }

  isStagedSession(sessionId: string) {
    return this.stagedSessionId === sessionId;
  }

  isTemporarySession(sessionId: string) {
    return this.temporarySessionIds.includes(sessionId);
  }

  isDraftSession(sessionId: string) {
    return this.draftSessionsById[sessionId] !== undefined;
  }

  draftSessionPrompt(sessionId: string) {
    return this.draftSessionsById[sessionId];
  }

  async createDraftSession(sessionId: string, text: string, attachments: Attachment[]) {
    if (!this.temporarySessionIds.includes(sessionId))
      throw new Error("Only a new session can be saved as a draft");
    const session = this.findSession(sessionId)!;
    const projectPath =
      this.props.catalog?.projectOfManagedWorktree(session.workspacePath) ?? session.workspacePath;
    this.relocateTemporarySession(sessionId, projectPath);
    this.draftSessionsById[sessionId] = {
      text,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      resolved: false,
    };
    this.ensurePendingSummaryMetadata(sessionId);
    if (this.stagedSessionId === sessionId) this.stagedSessionId = undefined;
    await this.props.persistNow();
  }

  async updateDraftSession(sessionId: string, text: string, attachments: Attachment[]) {
    const current = this.draftSessionsById[sessionId];
    if (!current) throw new Error("Cake could not find that draft session");
    this.draftSessionsById[sessionId] = {
      text,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      resolved: current.resolved,
    };
    await this.props.persistNow();
  }

  activateDraftSession(sessionId: string) {
    const current = this.draftSessionsById[sessionId];
    if (!current) return undefined;
    delete this.draftSessionsById[sessionId];
    this.touchPendingSummary(sessionId);
    return current;
  }

  setDraftSessionResolved(sessionId: string, resolved: boolean) {
    const current = this.draftSessionsById[sessionId];
    if (!current) return false;
    this.draftSessionsById[sessionId] = { ...current, resolved };
    this.touchPendingSummary(sessionId);
    return true;
  }

  relocateTemporarySession(sessionId: string, workspacePath: string) {
    if (!this.temporarySessionIds.includes(sessionId))
      throw new Error("Only an unsent session can choose another worktree.");
    const session = this.findSession(sessionId);
    const index = this.targets.findIndex((target) => target.sessionId === sessionId);
    if (!session || index < 0) throw new Error("Cake could not find that draft session.");
    const previousPath = session.workspacePath;
    if (previousPath === workspacePath) return;
    this.targets.splice(index, 1, { sessionId, workspacePath });
    updateStore(session, { ...session.props, workspacePath });
    void session.stagedCommandStore.load(workspacePath);
    if (this.isDraftSession(sessionId)) this.touchPendingSummary(sessionId);
  }

  pendingConfiguration(sessionId: string) {
    return this.pendingConfigurationsBySession[sessionId];
  }

  pendingName(sessionId: string) {
    return this.pendingNamesBySession[sessionId];
  }

  setPendingName(sessionId: string, name: string) {
    if (!this.temporarySessionIds.includes(sessionId))
      throw new Error("Only an unsent session can receive an initial name.");
    this.pendingNamesBySession[sessionId] = name;
    this.touchPendingSummary(sessionId);
  }

  applyGeneratedDraftName(sessionId: string, name: string) {
    if (!this.isDraftSession(sessionId) || this.pendingNamesBySession[sessionId]) return;
    this.setPendingName(sessionId, name);
  }

  setPendingConfiguration(sessionId: string, configuration: ChatConfiguration) {
    this.pendingConfigurationsBySession[sessionId] = configuration;
  }

  removeSession(sessionId: string) {
    const index = this.targets.findIndex((target) => target.sessionId === sessionId);
    if (index >= 0) this.targets.splice(index, 1);
    this.sessionsById.delete(sessionId);
    removeValue(this.temporarySessionIds, sessionId);
    if (this.stagedSessionId === sessionId) this.stagedSessionId = undefined;
    removeValue(this.unlistedNewSessionIds, sessionId);
    removeValue(this.materializedSessionIds, sessionId);
    removeValue(this.recentObservationSessionIds, sessionId);
    delete this.pendingConfigurationsBySession[sessionId];
    delete this.pendingNamesBySession[sessionId];
    delete this.draftSessionsById[sessionId];
    delete this.pendingSummaryMetadataBySession[sessionId];
    removeValue(this.submittingSessionIds, sessionId);
  }

  private isRunning(session: ProjectSessionStore) {
    return (
      session.model.streaming ||
      session.model.activeTurnIds.length > 0 ||
      session.model.backgroundWorkActive
    );
  }

  private isObservableSession(session: ProjectSessionStore) {
    return this.materializedSessionIds.includes(session.sessionId);
  }

  private touchObservationLru(sessionId: string) {
    removeValue(this.recentObservationSessionIds, sessionId);
    this.recentObservationSessionIds.push(sessionId);
  }

  private trimObservationLru() {
    for (let index = this.recentObservationSessionIds.length - 1; index >= 0; index -= 1) {
      const sessionId = this.recentObservationSessionIds[index]!;
      const session = this.findSession(sessionId);
      if (session && this.isObservableSession(session)) continue;
      this.recentObservationSessionIds.splice(index, 1);
    }
    const idleIds = this.recentObservationSessionIds.filter((sessionId) => {
      const session = this.findSession(sessionId)!;
      return !this.props.isActive(sessionId) && !this.isRunning(session);
    });
    while (idleIds.length > IDLE_OBSERVATION_LIMIT) {
      const sessionId = idleIds.shift()!;
      removeValue(this.recentObservationSessionIds, sessionId);
    }
  }

  private addTarget(sessionId: string, workspacePath: string) {
    const existing = this.findSession(sessionId);
    if (existing) return existing;
    this.targets.push({ sessionId, workspacePath });
    return this.findSession(sessionId)!;
  }

  private rememberSessionLocation(sessionId: string, workspacePath: string) {
    const prior =
      this.targets.find((target) => target.sessionId === sessionId)?.workspacePath ??
      this.props.catalog?.find(sessionId)?.workingDirectory;
    if (prior && prior !== workspacePath)
      throw new Error(`Session ID collision detected: ${sessionId}`);
  }

  private ensurePendingSummaryMetadata(sessionId: string) {
    if (this.pendingSummaryMetadataBySession[sessionId]) return;
    const now = new Date().toISOString();
    this.pendingSummaryMetadataBySession[sessionId] = { createdAt: now, modifiedAt: now };
  }

  private updatePendingSummaryMetadata(sessionId: string, fallbackTitle?: string) {
    const current = this.pendingSummaryMetadataBySession[sessionId];
    const now = new Date().toISOString();
    this.pendingSummaryMetadataBySession[sessionId] = {
      createdAt: current?.createdAt ?? now,
      modifiedAt: now,
      fallbackTitle: fallbackTitle ?? current?.fallbackTitle,
    };
  }

  private touchPendingSummary(sessionId: string) {
    this.updatePendingSummaryMetadata(sessionId);
  }

  private reconcileAuthoritativeSessions(sessionIds: readonly string[]) {
    const authoritative = new Set(sessionIds);
    for (let index = this.unlistedNewSessionIds.length - 1; index >= 0; index -= 1) {
      const sessionId = this.unlistedNewSessionIds[index]!;
      if (!authoritative.has(sessionId)) continue;
      this.unlistedNewSessionIds.splice(index, 1);
      delete this.pendingNamesBySession[sessionId];
      delete this.pendingSummaryMetadataBySession[sessionId];
    }
  }

  constructor(props: SessionRegistryStore["props"]) {
    super(props);
    this.reaction(
      () => this.props.catalog?.authoritativeSessionIds ?? [],
      (sessionIds) => this.reconcileAuthoritativeSessions(sessionIds),
    );
    this.reaction(
      () =>
        this.sessions.map((session) => ({
          sessionId: session.sessionId,
          active: this.props.isActive(session.sessionId),
          running: this.isRunning(session),
          resolved: this.props.catalog?.find(session.sessionId)?.resolved ?? false,
        })),
      (sessions, previousSessions) => {
        const previousById = new Map(
          previousSessions.map((session) => [session.sessionId, session]),
        );
        for (const session of sessions) {
          const previous = previousById.get(session.sessionId);
          if (
            previous &&
            ((previous.active && !session.active) || (previous.running && !session.running))
          )
            this.touchObservationLru(session.sessionId);
        }
        this.trimObservationLru();
      },
    );
  }
}

function addUnique(values: string[], value: string) {
  if (!values.includes(value)) values.push(value);
}

function removeValue(values: string[], value: string) {
  const index = values.indexOf(value);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
}
