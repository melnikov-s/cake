import { Store, snapshot } from "r-state-tree";
import type { StoreEvent } from "../events/StoreEvent";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export type ProjectOpenResult =
  | {
      path: string;
      kind: "new-session";
      sessionId?: string;
      stagedSession: boolean;
    }
  | { path: string; kind: "project"; sessionId?: string };

export interface ProjectOpenStoreProps {
  operations: SessionOperationCoordinatorStore;
  projects: ProjectCatalogStore;
  onOpening(): void;
  onAccepted(result: ProjectOpenResult): Promise<void> | void;
}

interface PendingProjectInspection {
  operationId: string;
  revision: number;
  path: string;
  newSession: boolean;
  stagedSession: boolean;
  sessionId?: string;
}

/** Owns Project selection, inspection, trust authorization, and latest-open policy. */
export class ProjectOpenStore extends Store<ProjectOpenStoreProps> {
  @snapshot projectPath: string | undefined;
  pendingTrustPath: string | undefined;
  error: string | undefined;
  errorDetails: string | undefined;
  private pendingInspection: PendingProjectInspection | undefined;
  private openRevision = 0;
  private pickerRevision = 0;

  get client() {
    return ClientContext.consume(this)!;
  }

  get isBusy() {
    return this.activeOperations.length > 0;
  }

  get activeOperations() {
    return this.props.operations.active("project-open");
  }

  get pendingAuthorizationPath() {
    return this.pendingInspection?.path;
  }

  get projectName() {
    return this.projectPath ? this.props.projects.nameForPath(this.projectPath) : "No workspace";
  }

  setError(error: unknown, context?: string) {
    const described = describeError(error, context);
    this.error = described.message;
    this.errorDetails = described.details;
  }

  activate(path: string) {
    this.projectPath = path;
  }

  clear(path?: string) {
    if (path !== undefined && path !== this.projectPath) return;
    this.cancelPending();
    this.projectPath = undefined;
  }

  /** Invalidates any Project inspection when another workbench target takes precedence. */
  cancelPending() {
    this.openRevision += 1;
    this.pickerRevision += 1;
    this.pendingTrustPath = undefined;
    this.error = undefined;
    this.errorDetails = undefined;
    const operationId = this.pendingInspection?.operationId;
    this.pendingInspection = undefined;
    if (operationId) this.props.operations.finish(operationId);
  }

  /** Re-authorizes a hydrated Working Directory before executable Project resources load. */
  initialize(input?: {
    path: string;
    newSession: boolean;
    sessionId?: string;
    stagedSession: boolean;
  }) {
    if (!input) {
      const path = this.projectPath;
      return path ? this.inspectPath(path) : Promise.resolve();
    }
    this.projectPath = input.path;
    return this.inspectPath(input.path, {
      newSession: input.newSession,
      sessionId: input.sessionId,
      stagedSession: input.stagedSession,
    });
  }

  /** Repeated picker requests are latest-wins. */
  async chooseProject() {
    const revision = ++this.pickerRevision;
    try {
      const path = await this.client.electron.chooseProject({ signal: this.signal });
      if (path && !this.signal.aborted && revision === this.pickerRevision)
        await this.inspectPath(path);
    } catch (error) {
      if (!this.signal.aborted && revision === this.pickerRevision)
        this.setError(error, "Choosing a project folder");
    }
  }

  /** Repeated one-off requests are latest-wins. */
  async startOneOffChat() {
    const revision = ++this.pickerRevision;
    try {
      const path = await this.client.application.getHomeDirectory({ signal: this.signal });
      if (!this.signal.aborted && revision === this.pickerRevision)
        await this.inspectPath(path, { newSession: true, stagedSession: true });
    } catch (error) {
      if (!this.signal.aborted && revision === this.pickerRevision) this.setError(error);
    }
  }

  async switchProject(path: string) {
    if (path === this.projectPath) return;
    await this.inspectPath(path);
  }

  async inspectPath(
    path: string,
    options: { newSession?: boolean; sessionId?: string; stagedSession?: boolean } = {},
  ) {
    this.pickerRevision += 1;
    const revision = ++this.openRevision;
    this.props.onOpening();
    const previousOperationId = this.pendingInspection?.operationId;
    if (previousOperationId) this.props.operations.finish(previousOperationId);
    const operationId = this.props.operations.start("project-open");
    this.error = undefined;
    this.errorDetails = undefined;
    this.pendingTrustPath = undefined;
    this.pendingInspection = {
      operationId,
      revision,
      path,
      newSession: options.newSession ?? false,
      stagedSession: options.stagedSession ?? false,
      sessionId: options.sessionId,
    };
    try {
      const inspection = await this.client.workspaces.inspect(
        { operationId, path },
        { signal: this.signal },
      );
      if (this.signal.aborted || revision !== this.openRevision) return;
      this.props.operations.finish(inspection.operationId);
      const pending = this.pendingInspection;
      if (!pending || pending.operationId !== inspection.operationId) return;
      if (inspection.trustRequired) this.pendingTrustPath = inspection.path;
      else await this.accept(pending, inspection.path);
    } catch (error) {
      this.props.operations.finish(operationId);
      if (this.signal.aborted || revision !== this.openRevision) return;
      if (this.pendingInspection?.operationId === operationId) this.pendingInspection = undefined;
      this.setError(error);
    }
  }

  async resolveProjectTrust(trusted: boolean) {
    const pending = this.pendingInspection;
    if (!pending || !this.pendingTrustPath || pending.revision !== this.openRevision) return;
    this.pendingTrustPath = undefined;
    try {
      await this.client.workspaces.respondToTrust({
        operationId: pending.operationId,
        path: pending.path,
        approved: trusted,
      });
    } catch (error) {
      if (this.signal.aborted || this.pendingInspection !== pending) return;
      this.pendingInspection = undefined;
      this.setError(error);
      return;
    }
    if (this.pendingInspection !== pending || pending.revision !== this.openRevision) return;
    if (!trusted) {
      this.pendingInspection = undefined;
      return;
    }
    await this.accept(pending);
  }

  receive(event: StoreEvent) {
    if (event.type === "operation-completed") {
      if (this.props.operations.includes(event.operationId, "project-open"))
        this.props.operations.finish(event.operationId);
      return;
    }
    if (
      event.type === "operation-failed" &&
      event.operationId &&
      this.props.operations.includes(event.operationId, "project-open")
    ) {
      this.props.operations.finish(event.operationId);
      if (this.pendingInspection?.operationId === event.operationId) {
        this.pendingInspection = undefined;
        this.pendingTrustPath = undefined;
      }
      this.error = event.message;
      this.errorDetails = event.details ?? event.message;
    }
  }

  private async accept(pending: PendingProjectInspection, inspectedPath = pending.path) {
    if (this.pendingInspection !== pending || pending.revision !== this.openRevision) return;
    this.pendingInspection = undefined;
    this.pendingTrustPath = undefined;
    if (pending.newSession) {
      void this.registerProject(inspectedPath, pending.revision);
      await this.props.onAccepted({
        path: inspectedPath,
        kind: "new-session",
        sessionId: pending.sessionId,
        stagedSession: pending.stagedSession,
      });
      return;
    }
    if (!(await this.registerProject(inspectedPath, pending.revision))) return;
    await this.props.onAccepted({
      path: inspectedPath,
      kind: "project",
      sessionId: pending.sessionId,
    });
  }

  private async registerProject(path: string, revision?: number) {
    try {
      await this.client.workspaces.registerProject(path, this.props.projects.nameFromPath(path), {
        signal: this.signal,
      });
      return !this.signal.aborted && (revision === undefined || revision === this.openRevision);
    } catch (error) {
      if (!this.signal.aborted && (revision === undefined || revision === this.openRevision))
        this.setError(error);
      return false;
    }
  }
}
