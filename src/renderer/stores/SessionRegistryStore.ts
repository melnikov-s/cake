import {
  Store,
  batch,
  child,
  computed,
  createStore,
  observable,
  snapshot,
  updateStore,
} from "r-state-tree";
import type { ModelPreset } from "../../contracts/conversations/session-contract";
import type { CakeControlTool } from "../../contracts/cake-chats/cake-chat-data";
import type { Conversation } from "../models/Conversation";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import type { DiscussionCatalog } from "../models/DiscussionCatalog";
import type { SubagentCatalog } from "../models/SubagentCatalog";
import type { WorkflowCatalog } from "../models/WorkflowCatalog";
import type { ScheduledMessageCatalog } from "../models/ScheduledMessageCatalog";
import { ProjectPendingSessionsStore, type SavedDraftClient } from "./ProjectPendingSessionsStore";
import { ProjectSessionStore, type SessionTarget } from "./ProjectSessionStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import { SessionObservationRetentionStore } from "./SessionObservationRetentionStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { WorktreeStoreProps } from "./WorktreeStore";
import type { WorktreeLandingOperation } from "../../contracts/worktrees/worktree-landing-data";
import { ProjectCatalogContext } from "./context/ProjectCatalogContext";
import { projectSessionForkPreview } from "../lib/session-fork-preview";

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
  selectedSessionId(): string | undefined;
  visibleSessionIds(): readonly string[];
  worktreeOperation(workspacePath: string): typeof WorktreeLandingOperation.Encoded | undefined;
  persistNow(): Promise<void>;
  modelPresets?(): readonly ModelPreset[];
  assistantTools?(): readonly CakeControlTool[];
  openModelPresetSettings?(): void;
  retirement: WorktreeStoreProps["retirement"];
}

/** Owns the keyed collection and stable identity of loaded Project Session Stores for a window. */
export class SessionRegistryStore extends Store<SessionRegistryStoreProps> {
  @snapshot readonly targets: SessionTarget[] = observable([]);
  private readonly sessionsById = new Map<string, ProjectSessionStore>();
  private readonly forkPreviews = observable(
    new Map<string, { title: string; sourceSessionId: string }>(),
  );

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
      activeSessions: () => this.activeSessions,
      selectedSessionId: this.props.selectedSessionId,
      visibleSessionIds: this.props.visibleSessionIds,
    });
  }

  @child
  get sessions(): ProjectSessionStore[] {
    return this.targets.map((target) =>
      createStore(ProjectSessionStore, {
        key: target.sessionId,
        ...target,
        model: this.props.sessionModel(target.sessionId, target.workspacePath),
        isForkPreview: () => this.isForkPreview(target.sessionId),
        discussionCatalog: this.props.discussionCatalog(target.sessionId),
        subagentCatalog: this.props.subagentCatalog(target.sessionId),
        workflowCatalog: this.props.workflowCatalog(target.sessionId),
        scheduledMessageCatalog: this.props.scheduledMessageCatalog(target.sessionId),
        artifactModel: this.props.artifactModel,
        operations: this.props.operations,
        reviews: this.props.reviews,
        isActive: () => this.props.selectedSessionId() === target.sessionId,
        worktreeOperation: () => this.props.worktreeOperation(target.workspacePath),
        projectName: () => this.projects.nameForPath(target.workspacePath),
        familyId: () =>
          this.props.catalog?.find(target.sessionId)?.familyId ??
          this.pendingSessions.familyId(target.sessionId),
        modelPresets: () => this.props.modelPresets?.() ?? [],
        assistantTools: () => this.props.assistantTools?.() ?? [],
        openModelPresetSettings: () => this.props.openModelPresetSettings?.(),
        retirement: this.props.retirement,
      }),
    );
  }

  /** Membership changes invalidate this projection; navigating between panes does not.
   * Unknown restored identities are cold until exact lookup or explicit navigation.
   */
  @computed
  get activeSessions(): readonly ProjectSessionStore[] {
    return this.targets.flatMap(({ sessionId }) => {
      const summary = this.props.catalog?.find(sessionId);
      if (summary ? summary.resolved : !this.pendingSessions.isTemporary(sessionId)) return [];
      const session = this.findSession(sessionId);
      return session ? [session] : [];
    });
  }

  /** Parents whose Discussion sidecars this window currently observes and renders. */
  @computed
  get discussionSessionDemand(): readonly ProjectSessionStore[] {
    const demand = new Map(
      this.observationRetention.sessions.map((session) => [session.sessionId, session]),
    );
    for (const session of this.activeSessions)
      if (this.pendingSessions.isTemporary(session.sessionId))
        demand.set(session.sessionId, session);
    return [...demand.values()];
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

  isForkPreview(sessionId: string) {
    return this.forkPreviews.has(sessionId);
  }

  get forkPreviewSources(): ReadonlyMap<string, string> {
    return new Map([...this.forkPreviews].map(([id, preview]) => [id, preview.sourceSessionId]));
  }

  forkPreviewTitle(sessionId: string) {
    return this.forkPreviews.get(sessionId)?.title;
  }

  prepareForkPreview(sourceSessionId: string, entryId: string, title: string) {
    const source = this.findSession(sourceSessionId);
    if (!source) throw new Error("Cake could not find the source session");
    const sessionId = crypto.randomUUID();
    this.forkPreviews.set(sessionId, { sourceSessionId, title: `Fork of ${title}` });
    const preview = this.prepareIdentity(sessionId, source.workspacePath);
    projectSessionForkPreview(source.model, preview.model, entryId);
    return preview;
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
    this.forkPreviews.delete(sessionId);
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
    // The pending workflow may have been activated in another window. Its
    // temporary target is allowed to move, but a disk-backed identity is not.
    const cataloged = this.props.catalog?.find(sessionId);
    if (cataloged && !cataloged.pending && cataloged.workingDirectory !== workingDirectory)
      throw new Error(`Session ID collision detected: ${sessionId}`);
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
