import { Store, batch, child, createStore, observable, snapshot, updateStore } from "r-state-tree";
import type { ModelPreset } from "../../contracts/conversations/session-contract";
import type { CakeControlTool } from "../../contracts/cake-chats/cake-chat-data";
import type { Conversation } from "../models/Conversation";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import type { DiscussionCatalog } from "../models/DiscussionCatalog";
import type { SubagentCatalog } from "../models/SubagentCatalog";
import type { WorkflowCatalog } from "../models/WorkflowCatalog";
import type { ScheduledMessageCatalog } from "../models/ScheduledMessageCatalog";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { ProjectPendingSessionsStore, type SavedDraftClient } from "./ProjectPendingSessionsStore";
import { ProjectSessionStore, type SessionTarget } from "./ProjectSessionStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import { SessionObservationRetentionStore } from "./SessionObservationRetentionStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { WorktreeStoreProps } from "./WorktreeStore";
import type { WorktreeLandingOperation } from "../../contracts/worktrees/worktree-landing-data";
import { ProjectCatalogContext } from "./context/ProjectCatalogContext";

export interface SessionRegistryStoreProps {
  catalog?: SessionCatalogStore;
  savedDrafts?: SavedDraftClient;
  sessionModel(sessionId: string, workingDirectory: string): Conversation;
  discussionCatalog(sessionId: string): DiscussionCatalog;
  subagentCatalog(sessionId: string): SubagentCatalog;
  workflowCatalog(sessionId: string): WorkflowCatalog;
  scheduledMessageCatalog(sessionId: string): ScheduledMessageCatalog;
  artifactModel: ArtifactCatalog;
  operations: SessionOperationCoordinatorStore;
  reviews(): ReviewsStore;
  isActive(sessionId: string): boolean;
  isVisible?(sessionId: string): boolean;
  worktreeOperation(workspacePath: string): typeof WorktreeLandingOperation.Encoded | undefined;
  persistNow(): Promise<void>;
  modelPresets?(): readonly ModelPreset[];
  assistantTools?(): readonly CakeControlTool[];
  openModelPresetSettings?(): void;
  retirement: WorktreeStoreProps["retirement"];
  settings?(): AppearanceSettingsStore | undefined;
}

/** Owns the keyed collection and stable identity of loaded Project Session Stores for a window. */
export class SessionRegistryStore extends Store<SessionRegistryStoreProps> {
  @snapshot readonly targets: SessionTarget[] = observable([]);
  private readonly sessionsById = new Map<string, ProjectSessionStore>();

  private get projects() {
    return ProjectCatalogContext.consume(this)!;
  }

  @child
  get pendingSessions(): ProjectPendingSessionsStore {
    return createStore(ProjectPendingSessionsStore, {
      catalog: this.props.catalog,
      savedDrafts: this.props.savedDrafts,
      session: (sessionId) => this.findSession(sessionId),
      prepareIdentity: (sessionId, workingDirectory) =>
        this.prepareIdentity(sessionId, workingDirectory),
      relocateIdentity: (sessionId, workingDirectory) =>
        this.relocateIdentity(sessionId, workingDirectory),
      materializeIdentity: (sessionId, workingDirectory) =>
        this.materializeIdentity(sessionId, workingDirectory),
      removeSession: (sessionId) => this.removeSession(sessionId),
      persistNow: this.props.persistNow,
      projectName: (workingDirectory) => this.projects.nameForPath(workingDirectory),
    });
  }

  @child
  get observationRetention(): SessionObservationRetentionStore {
    return createStore(SessionObservationRetentionStore, {
      findSession: (sessionId) => this.findSession(sessionId),
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
        discussionCatalog: this.props.discussionCatalog(target.sessionId),
        subagentCatalog: this.props.subagentCatalog(target.sessionId),
        workflowCatalog: this.props.workflowCatalog(target.sessionId),
        scheduledMessageCatalog: this.props.scheduledMessageCatalog(target.sessionId),
        artifactModel: this.props.artifactModel,
        operations: this.props.operations,
        reviews: this.props.reviews,
        isActive: () => this.props.isActive(target.sessionId),
        worktreeOperation: () => this.props.worktreeOperation(target.workspacePath),
        projectName: () => this.projects.nameForPath(target.workspacePath),
        familyId: () =>
          this.props.catalog?.find(target.sessionId)?.familyId ??
          this.pendingSessions.familyId(target.sessionId),
        modelPresets: () => this.props.modelPresets?.() ?? [],
        assistantTools: () => this.props.assistantTools?.() ?? [],
        openModelPresetSettings: () => this.props.openModelPresetSettings?.(),
        retirement: this.props.retirement,
        settings: () => this.props.settings?.(),
      }),
    );
  }

  /** Parents whose Discussion sidecars this window currently observes and renders. */
  get discussionSessionDemand(): readonly ProjectSessionStore[] {
    const retainedIds = new Set(
      this.observationRetention.sessions.map((session) => session.sessionId),
    );
    return this.sessions.filter(
      (session) =>
        retainedIds.has(session.sessionId) || this.pendingSessions.isTemporary(session.sessionId),
    );
  }

  /** Unsent pane identities not already represented by a surface's Project list. */
  unsentSessionsForProject(projectPath: string, listedSessions: readonly { sessionId: string }[]) {
    const listedIds = new Set(listedSessions.map((session) => session.sessionId));
    return this.sessions
      .filter(
        (session) =>
          this.pendingSessions.isTemporary(session.sessionId) &&
          !listedIds.has(session.sessionId) &&
          (this.props.catalog?.projectPathFor(session.workspacePath) ?? session.workspacePath) ===
            projectPath,
      )
      .map((session) => {
        const facts =
          this.pendingSessions.savedRecord(session.sessionId) ??
          this.pendingSessions.conversation(session.sessionId)!;
        return {
          sessionId: session.sessionId,
          title: facts.title,
          modifiedAt: facts.modifiedAt,
          workingDirectory: session.workspacePath,
          draft: true,
          familyParentSessionId: undefined,
          familyChildSessionIds: undefined,
          familyDepth: undefined,
        };
      });
  }

  findModel(sessionId: string) {
    return this.findSession(sessionId)?.model;
  }

  findSession(sessionId: string) {
    const cached = this.sessionsById.get(sessionId);
    if (cached) return cached;
    const index = this.targets.findIndex((target) => target.sessionId === sessionId);
    if (index < 0) return undefined;
    // Resolving the keyed child array realizes all of its Stores. Index them all
    // so switching to another already-loaded session does not reconcile the
    // entire child array again on its first lookup.
    for (const session of this.sessions) this.sessionsById.set(session.sessionId, session);
    return this.sessionsById.get(sessionId);
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
    family: {
      familyId: string;
      parentSessionId: string;
      childOrder: number;
      depth: number;
    },
  ) {
    return batch(() => {
      const session = this.load(sessionId, workingDirectory);
      this.pendingSessions.trackFamilyParent(family.parentSessionId, family.familyId);
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
