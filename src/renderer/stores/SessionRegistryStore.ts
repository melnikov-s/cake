import { Store, child, createStore, observable } from "r-state-tree";
import type { SessionPreview, SessionSnapshot } from "../../ipc/session-contract";
import type { ReviewThread } from "../../ipc/review-contract";
import type { DesktopClient } from "../desktop-client";
import type { SessionOperationCoordinator } from "./SessionOperationCoordinator";
import type { ReviewsStore } from "./ReviewsStore";
import type { PluginCommandStore } from "./PluginCommandStore";
import { ProjectSessionStore, sessionTargetKey, type SessionTarget } from "./ProjectSessionStore";

export interface SessionRegistryStoreProps {
  client: DesktopClient;
  operations: SessionOperationCoordinator;
  reviews(): ReviewsStore;
  pluginCommands(): PluginCommandStore;
  canSubmit(target: SessionTarget): boolean;
  isActive(target: SessionTarget): boolean;
  openCommandPane(pane: "changelog" | "tree" | "resources"): Promise<void>;
  persist(): void;
}

/** Owns the keyed collection of loaded per-session Store instances for a window. */
export class SessionRegistryStore extends Store<SessionRegistryStoreProps> {
  readonly targets: SessionTarget[] = observable([]);

  @child
  get sessions(): ProjectSessionStore[] {
    return this.targets.map((target) => createStore(ProjectSessionStore, {
      key: sessionTargetKey(target),
      ...target,
      client: this.props.client,
      registry: this,
      operations: this.props.operations,
      reviews: this.props.reviews,
      pluginCommands: this.props.pluginCommands,
      canSubmit: () => this.props.canSubmit(target),
      isActive: () => this.props.isActive(target),
      openCommandPane: (pane) => this.props.openCommandPane(pane),
      persist: () => this.props.persist()
    }));
  }

  findModel(sessionId: string, workspacePath?: string) {
    return this.findSession(sessionId, workspacePath)?.model;
  }

  findSession(sessionId: string, workspacePath?: string) {
    return this.sessions.find((session) => session.sessionId === sessionId && (!workspacePath || session.workspacePath === workspacePath));
  }

  ensure(sessionId: string, workspacePath: string) {
    let session = this.findSession(sessionId, workspacePath);
    if (!session) {
      this.targets.push({ sessionId, workspacePath });
      session = this.findSession(sessionId, workspacePath)!;
    }
    return session;
  }

  upsert(snapshot: SessionSnapshot) {
    const session = this.ensure(snapshot.sessionId, snapshot.workspacePath);
    session.model.applySnapshot(snapshot);
    return session.model;
  }

  hydratePreview(preview: SessionPreview) {
    const session = this.ensure(preview.sessionId, preview.workspacePath);
    session.model.applyPreview(preview);
    return session.model;
  }


  applyReviewThreads(workspacePath: string, sessionId: string, threads: ReviewThread[]) {
    const session = this.ensure(sessionId, workspacePath);
    session.model.applyReviewThreads(threads);
    return session.model;
  }

  upsertReviewThread(thread: ReviewThread) {
    const session = this.ensure(thread.sessionId, thread.workspacePath);
    session.model.upsertReviewThread(thread);
    return session.model;
  }
}
