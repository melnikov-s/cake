import { Store, child, createStore, observable, snapshot, updateStore } from "r-state-tree";
import type { Attachment, ChatConfiguration, ModelPreset } from "../../ipc/session-contract";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { PluginCommandStore } from "./PluginCommandStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { ProjectSessionStore, type SessionTarget } from "./ProjectSessionStore";
import type { WorktreeStoreProps } from "./WorktreeStore";
import type { ExistingWorktreeCandidate, WorktreeDraftChoice } from "./WorktreeCreationStore";

export interface SessionRegistryStoreProps {
  catalog?: SessionCatalogStore;
  operations: SessionOperationCoordinatorStore;
  reviews(): ReviewsStore;
  pluginCommands(): PluginCommandStore;
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
  /** The one unsent, unsaved project chat. Explicit drafts are not staged chats. */
  @snapshot private stagedSessionId: string | undefined;
  private readonly sessionsById = new Map<string, ProjectSessionStore>();
  private readonly sessionWorkspacePaths = new Map<string, string>();

  @child
  get sessions(): ProjectSessionStore[] {
    return this.targets.map((target) =>
      createStore(ProjectSessionStore, {
        key: target.sessionId,
        ...target,
        registry: this,
        operations: this.props.operations,
        reviews: this.props.reviews,
        pluginCommands: this.props.pluginCommands,
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
    return session;
  }

  get materializedSessions() {
    return this.sessions.filter((session) =>
      this.materializedSessionIds.includes(session.sessionId),
    );
  }

  markNewSessionStarted(sessionId: string) {
    if (!removeValue(this.temporarySessionIds, sessionId)) return;
    if (this.stagedSessionId === sessionId) this.stagedSessionId = undefined;
    delete this.pendingConfigurationsBySession[sessionId];
    delete this.pendingNamesBySession[sessionId];
    delete this.draftSessionsById[sessionId];
    this.props.catalog?.setDraft(sessionId, false);
    addUnique(this.unlistedNewSessionIds, sessionId);
  }

  retainedNewSessionIds(workspacePath: string) {
    return [
      ...this.temporarySessionIds.filter((sessionId) => !this.isStagedSession(sessionId)),
      ...this.unlistedNewSessionIds,
    ].filter((sessionId) => this.sessionWorkspacePaths.get(sessionId) === workspacePath);
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
    if (this.stagedSessionId === sessionId) this.stagedSessionId = undefined;
    this.props.catalog?.upsertPending(
      sessionId,
      session.workspacePath,
      this.props.projectName(session.workspacePath),
      { draft: true },
    );
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
    this.props.catalog?.setDraft(sessionId, false);
    this.props.catalog?.setResolved(sessionId, false);
    return current;
  }

  setDraftSessionResolved(sessionId: string, resolved: boolean) {
    const current = this.draftSessionsById[sessionId];
    if (!current) return false;
    this.draftSessionsById[sessionId] = { ...current, resolved };
    this.props.catalog?.setResolved(sessionId, resolved);
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
    this.sessionWorkspacePaths.set(sessionId, workspacePath);
    this.targets.splice(index, 1, { sessionId, workspacePath });
    updateStore(session, { ...session.props, workspacePath });
    if (this.isDraftSession(sessionId))
      this.props.catalog?.upsertPending(
        sessionId,
        workspacePath,
        this.props.projectName(workspacePath),
        {
          draft: true,
          resolved: this.draftSessionPrompt(sessionId)?.resolved,
        },
      );
  }

  commandsForSession(sessionId: string, workspacePath: string) {
    const session = this.findSession(sessionId);
    if (session?.model.commands.length) return session.model.commands;
    return (
      this.sessions.find(
        (candidate) =>
          candidate.sessionId !== sessionId &&
          candidate.workspacePath === workspacePath &&
          candidate.hydrated &&
          candidate.model.commands.length > 0,
      )?.model.commands ?? []
    );
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
    this.props.catalog?.rename(sessionId, name);
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
    delete this.pendingConfigurationsBySession[sessionId];
    delete this.pendingNamesBySession[sessionId];
    delete this.draftSessionsById[sessionId];
    this.sessionWorkspacePaths.delete(sessionId);
    this.props.catalog?.remove(sessionId);
  }

  private addTarget(sessionId: string, workspacePath: string) {
    const existing = this.findSession(sessionId);
    if (existing) return existing;
    this.targets.push({ sessionId, workspacePath });
    return this.findSession(sessionId)!;
  }

  private rememberSessionLocation(sessionId: string, workspacePath: string) {
    const prior =
      this.sessionWorkspacePaths.get(sessionId) ??
      this.props.catalog?.find(sessionId)?.workingDirectory;
    if (prior && prior !== workspacePath)
      throw new Error(`Session ID collision detected: ${sessionId}`);
    this.sessionWorkspacePaths.set(sessionId, workspacePath);
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
