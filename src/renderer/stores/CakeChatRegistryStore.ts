import { Store, child, createStore, observable, snapshot } from "r-state-tree";
import {
  CAKE_CHAT_SESSION_ID,
  type CakeChatTarget,
} from "../../contracts/cake-chats/cake-chat-data";
import type { ModelPreset } from "../../contracts/conversations/session-contract";
import type { Conversation } from "../models/Conversation";
import type { ArtifactCatalog } from "../models/ArtifactCatalog";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import type { CakeChatControls } from "../models/CakeChatControls";
import type { WorkflowCatalog } from "../models/WorkflowCatalog";
import type { SubagentCatalog } from "../models/SubagentCatalog";
import type { CakeChatPendingSessionsStore, CakeControlTool } from "./CakeChatPendingSessionsStore";
import { CakeChatSessionStore } from "./CakeChatSessionStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface CakeChatRegistryStoreProps {
  sessionModel(sessionId: string): Conversation;
  artifactModel: ArtifactCatalog;
  controlsModel(sessionId: string): CakeChatControls;
  subagentCatalog(sessionId: string): SubagentCatalog;
  workflowCatalog(sessionId: string): WorkflowCatalog;
  tools(): ReadonlyArray<CakeControlTool>;
  pendingSessions(): CakeChatPendingSessionsStore;
  operations: SessionOperationCoordinatorStore;
  isVisible(sessionId: string): boolean;
  modelPresets?(): readonly ModelPreset[];
  openModelPresetSettings?(): void;
  settings?(): AppearanceSettingsStore | undefined;
}

/** Owns loaded Cake Chat target identities and their stable keyed Session Store instances. */
export class CakeChatRegistryStore extends Store<CakeChatRegistryStoreProps> {
  @snapshot readonly targets: string[] = observable([]);
  private readonly sessionsById = new Map<string, CakeChatSessionStore>();

  @child
  get sessions(): CakeChatSessionStore[] {
    return this.targets.map((sessionId) =>
      createStore(CakeChatSessionStore, {
        key: sessionId,
        sessionId,
        model: this.props.sessionModel(sessionId),
        artifactModel: this.props.artifactModel,
        controls: this.props.controlsModel(sessionId),
        subagentCatalog: this.props.subagentCatalog(sessionId),
        workflowCatalog: this.props.workflowCatalog,
        target: () => this.target(sessionId),
        pendingSessions: this.props.pendingSessions(),
        operations: this.props.operations,
        modelPresets: () => this.props.modelPresets?.() ?? [],
        openModelPresetSettings: () => this.props.openModelPresetSettings?.(),
        settings: () => this.props.settings?.(),
      }),
    );
  }

  /** Visible or running Cake Chats whose transcript projections should remain synchronized. */
  get observationTargets(): ReadonlyArray<CakeChatTarget> {
    return this.sessions
      .filter(
        (session) =>
          !this.props.pendingSessions().isPending(session.sessionId) &&
          (this.props.isVisible(session.sessionId) || isRunning(session.model)),
      )
      .map((session) => this.target(session.sessionId));
  }

  find(sessionId: string) {
    const cached = this.sessionsById.get(sessionId);
    if (cached) return cached;
    const session = this.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (session) this.sessionsById.set(sessionId, session);
    return session;
  }

  load(sessionId: string) {
    sessionId = CAKE_CHAT_SESSION_ID;
    const existing = this.find(sessionId);
    if (existing) return existing;
    this.targets.push(sessionId);
    return this.find(sessionId)!;
  }

  remove(sessionId: string) {
    const index = this.targets.indexOf(sessionId);
    if (index >= 0) this.targets.splice(index, 1);
    this.sessionsById.delete(sessionId);
  }

  /** Reconciles pending identities against the authoritative catalog without replacing loaded Stores. */
  reconcile(authoritativeSessionIds: ReadonlySet<string>) {
    for (let i = this.targets.length - 1; i >= 0; i -= 1) {
      const id = this.targets[i]!;
      if (id !== CAKE_CHAT_SESSION_ID) this.remove(id);
    }
    this.props.pendingSessions().reconcileMaterialized(authoritativeSessionIds);
  }

  target(sessionId: string): CakeChatTarget {
    return { sessionId, tools: this.props.tools() };
  }
}

function isRunning(model: Conversation) {
  return model.streaming || model.activeTurnIds.length > 0;
}
