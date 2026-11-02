import { Store, child, createStore, observable, snapshot } from "r-state-tree";
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
  @snapshot readonly identities: AutomationSessionIdentity[] = observable([]);
  @snapshot selectedSessionId: string | undefined;

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
        initialTitle:
          this.catalog.unresolvedSessions.find((item) => item.sessionId === identity.sessionId)
            ?.title ??
          this.catalog.automations.find((item) => item.id === identity.automationId)?.name ??
          "Automation run",
        currentTitle: () =>
          this.catalog.unresolvedSessions.find((item) => item.sessionId === identity.sessionId)
            ?.title,
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

  hasSession(sessionId: string) {
    return (
      this.catalog.unresolvedSessions.some((session) => session.sessionId === sessionId) ||
      this.identities.some((item) => item.sessionId === sessionId)
    );
  }
  isResolved(sessionId: string) {
    return (
      this.catalog.loaded &&
      !this.catalog.unresolvedSessions.some((session) => session.sessionId === sessionId)
    );
  }
  sessionsForProject(projectPath: string | undefined) {
    return this.catalog.unresolvedSessions
      .filter((session) =>
        projectPath === undefined
          ? session.identity?.context._tag === "Global"
          : session.identity?.context._tag === "Project" &&
            session.identity.context.projectPath === projectPath,
      )
      .sort(
        (left, right) =>
          Number(right.running) - Number(left.running) ||
          right.modifiedAt.localeCompare(left.modifiedAt) ||
          left.sessionId.localeCompare(right.sessionId),
      );
  }

  openSession(sessionId: string) {
    const session = this.loadSession(sessionId);
    if (!session) return false;
    this.selectedSessionId = sessionId;
    return true;
  }

  loadSession(sessionId: string) {
    const identity =
      this.catalog.unresolvedSessions.find((session) => session.sessionId === sessionId)
        ?.identity ?? this.identities.find((item) => item.sessionId === sessionId);
    if (!identity) return undefined;
    if (!this.identities.some((item) => item.sessionId === sessionId))
      this.identities.push(identity);
    return this.sessions.find((session) => session.sessionId === sessionId);
  }

  /** History supplies resolved runs' real identity/context without Project Session lookup. */
  openRun(run: AutomationRun, title?: string) {
    this.loadRun(run, title);
    this.selectedSessionId = run.sessionId;
  }

  loadRun(run: AutomationRun, title?: string) {
    const identity: AutomationSessionIdentity = {
      _tag: "AutomationSession",
      sessionId: run.sessionId,
      automationId: run.automationId,
      runId: run.id,
      context: run.context,
      workingDirectory: run.workingDirectory,
    };
    if (!this.identities.some((item) => item.sessionId === run.sessionId))
      this.identities.push(identity);
    const session = this.sessions.find((session) => session.sessionId === run.sessionId)!;
    if (title) session.title = title;
    return session;
  }

  closeSession(sessionId: string) {
    const index = this.identities.findIndex((item) => item.sessionId === sessionId);
    if (index >= 0) this.identities.splice(index, 1);
    if (this.selectedSessionId === sessionId)
      this.selectedSessionId = this.identities.at(-1)?.sessionId;
  }
}
