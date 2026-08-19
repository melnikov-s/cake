import { Store, applySnapshot, child, createStore, observable } from "r-state-tree";
import type { SessionPreview, SessionSnapshot } from "../../ipc/session-contract";
import type { ReviewThread } from "../../ipc/review-contract";
import type { DesktopClient } from "../desktop-client";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { PluginCommandStore } from "./PluginCommandStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import { ProjectSessionStore, type SessionTarget } from "./ProjectSessionStore";
import { toSessionPreviewSnapshot, toSessionSnapshot } from "../../utils/session-snapshot";

export interface SessionRegistryStoreProps {
  client: DesktopClient;
  catalog?: SessionCatalogStore;
  operations: SessionOperationCoordinatorStore;
  reviews(): ReviewsStore;
  pluginCommands(): PluginCommandStore;
  canSubmit(sessionId: string): boolean;
  isActive(sessionId: string): boolean;
  openCommandPane(pane: "changelog" | "tree" | "resources"): Promise<void>;
  persist(): void;
  projectName(workspacePath: string): string;
  abort(): Promise<void>;
}

/** Owns the keyed collection of loaded per-session Store instances for a window. */
export class SessionRegistryStore extends Store<SessionRegistryStoreProps> {
  readonly targets: SessionTarget[] = observable([]);
  // Empty Pi sessions have no catalog entry, so retain their identity by project
  // until the first persisted prompt makes them discoverable.
  private readonly pendingNewSessionIdsByWorkspace: Record<string, string> = observable({});
  private readonly sessionWorkspacePaths = new Map<string, string>();

  @child
  get sessions(): ProjectSessionStore[] {
    return this.targets.map((target) =>
      createStore(ProjectSessionStore, {
        key: target.sessionId,
        ...target,
        client: this.props.client,
        registry: this,
        operations: this.props.operations,
        reviews: this.props.reviews,
        pluginCommands: this.props.pluginCommands,
        canSubmit: () => this.props.canSubmit(target.sessionId),
        isActive: () => this.props.isActive(target.sessionId),
        openCommandPane: (pane) => this.props.openCommandPane(pane),
        persist: () => this.props.persist(),
        projectName: () => this.props.projectName(target.workspacePath),
        abort: () => this.props.abort(),
      }),
    );
  }

  findModel(sessionId: string) {
    return this.findSession(sessionId)?.model;
  }

  findSession(sessionId: string) {
    return this.sessions.find((session) => session.sessionId === sessionId);
  }

  ensure(sessionId: string) {
    let session = this.findSession(sessionId);
    if (!session) {
      const workspacePath = this.workspacePathFor(sessionId);
      this.targets.push({ sessionId, workspacePath });
      session = this.findSession(sessionId)!;
    }
    return session;
  }

  pendingNewSession(workspacePath: string) {
    const sessionId = this.pendingNewSessionIdsByWorkspace[workspacePath];
    if (!sessionId) return undefined;
    const session = this.findSession(sessionId);
    if (session) return session;
    delete this.pendingNewSessionIdsByWorkspace[workspacePath];
    return undefined;
  }

  rememberNewSession(workspacePath: string, sessionId: string) {
    const current = this.pendingNewSessionIdsByWorkspace[workspacePath];
    if (current && current !== sessionId) return;
    this.pendingNewSessionIdsByWorkspace[workspacePath] = sessionId;
  }

  pendingNewSessionDrafts() {
    const drafts: Record<string, string> = {};
    for (const workspacePath of Object.keys(this.pendingNewSessionIdsByWorkspace)) {
      const session = this.pendingNewSession(workspacePath);
      if (session) drafts[workspacePath] = session.chatStore.draft;
    }
    return drafts;
  }

  upsert(snapshot: SessionSnapshot) {
    this.rememberSessionLocation(snapshot.sessionId, snapshot.workspacePath);
    const session = this.ensure(snapshot.sessionId);
    applySnapshot(session.model, toSessionSnapshot(snapshot));
    if (
      snapshot.parts.length > 0 &&
      this.pendingNewSessionIdsByWorkspace[snapshot.workspacePath] === snapshot.sessionId
    ) {
      delete this.pendingNewSessionIdsByWorkspace[snapshot.workspacePath];
      this.props.persist();
    }
    return session.model;
  }

  hydratePreview(preview: SessionPreview) {
    this.rememberSessionLocation(preview.sessionId, preview.workspacePath);
    const session = this.ensure(preview.sessionId);
    applySnapshot(session.model, toSessionPreviewSnapshot(preview));
    return session.model;
  }

  applyReviewThreads(sessionId: string, threads: ReviewThread[]) {
    if (!this.findSession(sessionId) && threads[0])
      this.rememberSessionLocation(sessionId, threads[0].workspacePath);
    const session =
      this.findSession(sessionId) ?? (threads.length > 0 ? this.ensure(sessionId) : undefined);
    if (!session) return undefined;
    session.model.applyReviewThreads(threads);
    return session.model;
  }

  upsertReviewThread(thread: ReviewThread) {
    this.rememberSessionLocation(thread.sessionId, thread.workspacePath);
    const session = this.ensure(thread.sessionId);
    session.model.upsertReviewThread(thread);
    return session.model;
  }

  private workspacePathFor(sessionId: string) {
    const workspacePath =
      this.props.catalog?.find(sessionId)?.workspacePath ??
      this.sessionWorkspacePaths.get(sessionId);
    if (!workspacePath) throw new Error(`Cake could not find session ${sessionId}`);
    return workspacePath;
  }

  private rememberSessionLocation(sessionId: string, workspacePath: string) {
    const prior =
      this.sessionWorkspacePaths.get(sessionId) ??
      this.props.catalog?.find(sessionId)?.workspacePath;
    if (prior && prior !== workspacePath)
      throw new Error(`Session ID collision detected: ${sessionId}`);
    this.sessionWorkspacePaths.set(sessionId, workspacePath);
  }
}
