import { Store, child, createStore, observable } from "r-state-tree";
import type {
  AutomationRun,
  AutomationSessionIdentity,
} from "../../contracts/automations/automation-data";
import type { ModelPreset } from "../../contracts/conversations/session-contract";
import type { RootProjection } from "../models/RootProjection";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { AutomationSessionStore } from "./AutomationSessionStore";

/** Window-owned automation identities; multiple runs coexist independently of the hub selection. */
export class AutomationSessionsStore extends Store<{
  projection: RootProjection;
  operations: SessionOperationCoordinatorStore;
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
}> {
  readonly identities: AutomationSessionIdentity[] = observable([]);
  selectedSessionId: string | undefined;

  get catalog() {
    return this.props.projection.automations;
  }
  get selectedSession() {
    return this.sessions.find((session) => session.sessionId === this.selectedSessionId);
  }
  get observationTargets() {
    return this.identities.map(({ sessionId }) => ({ sessionId }));
  }

  @child get sessions(): AutomationSessionStore[] {
    return this.identities.map((identity) =>
      createStore(AutomationSessionStore, {
        key: identity.sessionId,
        identity,
        model: this.props.projection.automationConversation(identity.sessionId),
        resolved: () =>
          this.catalog.loaded &&
          !this.catalog.unresolvedSessions.some(
            (session) => session.sessionId === identity.sessionId,
          ),
        operations: this.props.operations,
        modelPresets: this.props.modelPresets,
        openModelPresetSettings: this.props.openModelPresetSettings,
      }),
    );
  }

  openSession(sessionId: string) {
    const identity =
      this.catalog.unresolvedSessions.find((session) => session.sessionId === sessionId)
        ?.identity ?? this.identities.find((item) => item.sessionId === sessionId);
    if (!identity) return false;
    this.openIdentity(identity);
    return true;
  }

  /** History supplies resolved runs' real identity/context without Project Session lookup. */
  openRun(run: AutomationRun) {
    this.openIdentity({
      _tag: "AutomationSession",
      sessionId: run.sessionId,
      automationId: run.automationId,
      runId: run.id,
      context: run.context,
      workingDirectory: run.workingDirectory,
    });
  }

  private openIdentity(identity: AutomationSessionIdentity) {
    if (!this.identities.some((item) => item.sessionId === identity.sessionId))
      this.identities.push(identity);
    this.selectedSessionId = identity.sessionId;
  }

  closeSession(sessionId: string) {
    const index = this.identities.findIndex((item) => item.sessionId === sessionId);
    if (index >= 0) this.identities.splice(index, 1);
    if (this.selectedSessionId === sessionId)
      this.selectedSessionId = this.identities.at(-1)?.sessionId;
  }
}
