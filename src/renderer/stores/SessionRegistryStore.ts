import { Store, batch, child, createStore, observable, snapshot, updateStore } from "r-state-tree";
import type { ChatConfiguration, ModelPreset } from "../../ipc/session-contract";
import type { Session } from "../models/Session";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { ProjectPendingSessionsStore } from "./ProjectPendingSessionsStore";
import { ProjectSessionStore, type SessionTarget } from "./ProjectSessionStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import { SessionObservationRetentionStore } from "./SessionObservationRetentionStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { WorktreeStoreProps } from "./WorktreeStore";
import type { WorktreeLandingOperation } from "../../domain/worktree-landing-data";
import type { ExistingWorktreeCandidate, WorktreeDraftChoice } from "./WorktreeCreationStore";

export interface SessionRegistryStoreProps {
  catalog?: SessionCatalogStore;
  sessionModel(sessionId: string, workingDirectory: string): Session;
  operations: SessionOperationCoordinatorStore;
  reviews(): ReviewsStore;
  canSubmit(sessionId: string): boolean;
  isActive(sessionId: string): boolean;
  isVisible?(sessionId: string): boolean;
  worktreeOperation(workspacePath: string): WorktreeLandingOperation | undefined;
  openCommandPane(pane: "changelog" | "tree" | "resources"): Promise<void>;
  persistNow(): Promise<void>;
  projectName(workingDirectory: string): string;
  abort(sessionId: string): Promise<void>;
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
  retirement: WorktreeStoreProps["retirement"];
  onResolveWorktree: WorktreeStoreProps["onResolveWorkspace"];
  settings?(): AppearanceSettingsStore | undefined;
}

/** Owns the keyed collection and stable identity of loaded Project Session Stores for a window. */
export class SessionRegistryStore extends Store<SessionRegistryStoreProps> {
  @snapshot readonly targets: SessionTarget[] = observable([]);
  private readonly sessionsById = new Map<string, ProjectSessionStore>();

  @child
  get pendingSessions(): ProjectPendingSessionsStore {
    return createStore(ProjectPendingSessionsStore, {
      catalog: this.props.catalog,
      session: (sessionId) => this.findSession(sessionId),
      prepareIdentity: (sessionId, workingDirectory) =>
        this.prepareIdentity(sessionId, workingDirectory),
      relocateIdentity: (sessionId, workingDirectory) =>
        this.relocateIdentity(sessionId, workingDirectory),
      materializeIdentity: (sessionId, workingDirectory) =>
        this.materializeIdentity(sessionId, workingDirectory),
      removeSession: (sessionId) => this.removeSession(sessionId),
      persistNow: this.props.persistNow,
      projectName: this.props.projectName,
    });
  }

  @child
  get observationRetention(): SessionObservationRetentionStore {
    return createStore(SessionObservationRetentionStore, {
      sessions: () => this.sessions,
      isActive: this.props.isActive,
      isVisible: this.props.isVisible,
    });
  }

  @child
  get sessions(): ProjectSessionStore[] {
    return this.targets.map((target) =>
      createStore(ProjectSessionStore, {
        key: target.sessionId,
        ...target,
        model: this.props.sessionModel(target.sessionId, target.workspacePath),
        pendingSessions: this.pendingSessions,
        operations: this.props.operations,
        reviews: this.props.reviews,
        canSubmit: () => this.props.canSubmit(target.sessionId),
        isActive: () => this.props.isActive(target.sessionId),
        worktreeOperation: () => this.props.worktreeOperation(target.workspacePath),
        openCommandPane: this.props.openCommandPane,
        projectName: () => this.props.projectName(target.workspacePath),
        abort: () => this.props.abort(target.sessionId),
        renameSession: (name) => this.props.renameSession(target.sessionId, name),
        handoffSession: this.props.handoffSession,
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
        retirement: this.props.retirement,
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
    const session = this.prepareIdentity(sessionId, workingDirectory);
    this.observationRetention.materialize(sessionId);
    return session;
  }

  /** Makes a main-created family child visible until the disk-backed catalog catches up. */
  loadUnlistedFamilySession(
    sessionId: string,
    workingDirectory: string,
    title: string,
    family: { familyId: string; parentSessionId: string; childOrder: number },
  ) {
    return batch(() => {
      const session = this.load(sessionId, workingDirectory);
      this.pendingSessions.trackUnlistedFamilySession(sessionId, title, family);
      return session;
    });
  }

  removeSession(sessionId: string) {
    const index = this.targets.findIndex((target) => target.sessionId === sessionId);
    if (index >= 0) this.targets.splice(index, 1);
    this.sessionsById.delete(sessionId);
    this.pendingSessions.remove(sessionId);
    this.observationRetention.remove(sessionId);
  }

  private prepareIdentity(sessionId: string, workingDirectory: string) {
    this.assertSessionLocation(sessionId, workingDirectory);
    const existing = this.findSession(sessionId);
    if (existing) return existing;
    this.targets.push({ sessionId, workspacePath: workingDirectory });
    return this.findSession(sessionId)!;
  }

  private materializeIdentity(sessionId: string, workingDirectory: string) {
    this.assertSessionLocation(sessionId, workingDirectory);
    const session = this.relocateIdentity(sessionId, workingDirectory);
    this.observationRetention.materialize(sessionId);
    return session;
  }

  private relocateIdentity(sessionId: string, workingDirectory: string) {
    const session = this.findSession(sessionId);
    const index = this.targets.findIndex((target) => target.sessionId === sessionId);
    if (!session || index < 0) throw new Error("Cake could not find that draft session.");
    if (session.workspacePath === workingDirectory) return session;
    this.targets.splice(index, 1, { sessionId, workspacePath: workingDirectory });
    updateStore(session, { ...session.props, workspacePath: workingDirectory });
    return session;
  }

  private assertSessionLocation(sessionId: string, workingDirectory: string) {
    const prior =
      this.targets.find((target) => target.sessionId === sessionId)?.workspacePath ??
      this.props.catalog?.find(sessionId)?.workingDirectory;
    if (prior && prior !== workingDirectory)
      throw new Error(`Session ID collision detected: ${sessionId}`);
  }
}
