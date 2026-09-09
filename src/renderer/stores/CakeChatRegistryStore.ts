import { Store, child, createStore, observable, snapshot } from "r-state-tree";
import type { CakeChatTarget } from "../../domain/cake-chat-data";
import type { ModelPreset } from "../../ipc/session-contract";
import type { Session } from "../models/Session";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import type { CakeChatManagementStore } from "./CakeChatManagementStore";
import type { CakeChatPendingSessionsStore, CakeControlTool } from "./CakeChatPendingSessionsStore";
import { CakeChatSessionStore } from "./CakeChatSessionStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface CakeChatRegistryStoreProps {
  sessionModel(sessionId: string): Session;
  tools(): ReadonlyArray<CakeControlTool>;
  pendingSessions(): CakeChatPendingSessionsStore;
  management(): CakeChatManagementStore;
  operations: SessionOperationCoordinatorStore;
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
        target: () => this.target(sessionId),
        pendingSessions: this.props.pendingSessions(),
        management: this.props.management(),
        operations: this.props.operations,
        modelPresets: () => this.props.modelPresets?.() ?? [],
        openModelPresetSettings: () => this.props.openModelPresetSettings?.(),
        settings: () => this.props.settings?.(),
      }),
    );
  }

  /** Loaded Cake Chat targets whose transcript projections should remain synchronized. */
  get observationTargets(): ReadonlyArray<CakeChatTarget> {
    return this.sessions
      .filter((session) => !this.props.pendingSessions().isPending(session.sessionId))
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
    this.props.pendingSessions().reconcileMaterialized(authoritativeSessionIds);
  }

  target(sessionId: string): CakeChatTarget {
    return { sessionId, tools: this.props.tools() };
  }
}
