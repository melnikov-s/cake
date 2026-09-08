import { Store, observable } from "r-state-tree";
import {
  type ProjectWorkflowColor,
  type ProjectWorkflowMutation,
  validateProjectWorkflowColumnName,
} from "../../domain/application-data";
import type { Project } from "../models/Project";
import { ClientContext } from "./context/ClientContext";
import type { ProjectCatalogStore } from "./ProjectCatalogStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";

type KanbanSystemColumnId = "draft" | "active" | "resolved";
export type KanbanColumnId = KanbanSystemColumnId | string;

export interface KanbanStoreProps {
  projects: ProjectCatalogStore;
  catalog: SessionCatalogStore;
  registry: SessionRegistryStore;
  selectedProjectPath(): string | undefined;
  utilityModelConfigured(): boolean;
  openSession(sessionId: string): Promise<boolean>;
  reportError(error: unknown): void;
}

/** Owns the Project Kanban surface and the semantic meaning of completed drops. */
export class KanbanStore extends Store<KanbanStoreProps> {
  private readonly pendingSessionIds = observable(new Set<string>());
  private readonly pendingColumnIds = observable(new Set<string>());
  private readonly attemptedDetailSessionIds = new Set<string>();
  private readonly detailQueue: Array<{
    sessionId: string;
    projectPath: string;
    workingDirectory: string;
    title: string;
    firstUserMessage?: string;
  }> = [];
  private detailWorkerRunning = false;
  error: string | undefined;

  constructor(props: KanbanStore["props"]) {
    super(props);
    this.effect(() => {
      if (!this.projectPath) return;
      for (const session of this.sessions) {
        const details = this.detailsForSession(session.sessionId);
        if (session.draft) {
          const firstUserMessage = this.props.registry.draftSessionPrompt(session.sessionId)?.text;
          if (
            this.props.utilityModelConfigured() &&
            !details?.description &&
            firstUserMessage?.trim()
          )
            this.enqueueSessionDetails(
              { ...session, firstUserMessage },
              `description:${session.sessionId}`,
            );
        } else if (!details?.model)
          this.enqueueSessionDetails(session, `model:${session.sessionId}`);
        else if (this.props.utilityModelConfigured() && !details?.description)
          this.enqueueSessionDetails(session, `description:${session.sessionId}`);
      }
    });
  }

  get client() {
    return ClientContext.consume(this)!;
  }

  get projectPath() {
    return this.props.selectedProjectPath();
  }

  get project(): Project | undefined {
    const path = this.projectPath;
    return path ? this.props.projects.find(path) : undefined;
  }

  get customColumns() {
    return this.project?.workflow.columns ?? [];
  }

  get sessions() {
    const path = this.projectPath;
    return path ? this.props.catalog.projectSessions(path) : [];
  }

  sessionsInColumn(columnId: KanbanColumnId) {
    return this.sessions.filter((session) => this.columnForSession(session.sessionId) === columnId);
  }

  columnForSession(sessionId: string): KanbanColumnId {
    const session = this.props.catalog.find(sessionId);
    if (!session || session.draft) return "draft";
    if (session.resolved) return "resolved";
    const project = this.props.projects.find(session.projectPath);
    const statusId = project?.workflow.assignments.find(
      (assignment) => assignment.sessionId === sessionId,
    )?.statusId;
    return statusId && project?.workflow.columns.some((column) => column.id === statusId)
      ? statusId
      : "active";
  }

  statusForSession(sessionId: string) {
    const session = this.props.catalog.find(sessionId);
    const columnId = this.columnForSession(sessionId);
    return session
      ? this.props.projects
          .find(session.projectPath)
          ?.workflow.columns.find((column) => column.id === columnId)
      : undefined;
  }

  detailsForSession(sessionId: string) {
    return this.project?.workflow.sessionDetails.find((details) => details.sessionId === sessionId);
  }

  modelForSession(sessionId: string) {
    const loaded = this.props.registry.findSession(sessionId);
    const runtimeModel = loaded?.model.model;
    if (runtimeModel) return runtimeModel.name || runtimeModel.id;
    const pending = this.props.registry.pendingConfiguration(sessionId);
    if (pending) return pending.modelId;
    const stored = this.detailsForSession(sessionId)?.model;
    return stored?.name || stored?.modelId;
  }

  isSessionPending(sessionId: string) {
    return this.pendingSessionIds.has(sessionId);
  }

  canMoveSessionToResolved(sessionId: string) {
    const session = this.props.catalog.find(sessionId);
    return Boolean(
      session &&
      !session.draft &&
      !session.resolved &&
      (!session.familyParentSessionId || session.familyParentSessionId === session.sessionId),
    );
  }

  isColumnPending(columnId: string) {
    return this.pendingColumnIds.has(columnId);
  }

  async openSession(sessionId: string) {
    await this.props.openSession(sessionId);
  }

  private enqueueSessionDetails(
    session: {
      sessionId: string;
      projectPath: string;
      workingDirectory: string;
      title: string;
      firstUserMessage?: string;
    },
    attemptKey: string,
  ) {
    if (this.attemptedDetailSessionIds.has(attemptKey)) return;
    this.attemptedDetailSessionIds.add(attemptKey);
    this.detailQueue.push({ ...session });
    if (!this.detailWorkerRunning) void this.runDetailQueue();
  }

  private async runDetailQueue() {
    this.detailWorkerRunning = true;
    try {
      while (!this.signal.aborted) {
        const session = this.detailQueue.shift();
        if (!session) return;
        if (!this.props.projects.find(session.projectPath)) continue;
        try {
          await this.client.projectWorkflow.describeSession(session, { signal: this.signal });
        } catch {
          // Advisory background metadata must not interrupt the board workflow.
        }
      }
    } finally {
      this.detailWorkerRunning = false;
    }
  }

  async addColumn(name: string, color: ProjectWorkflowColor) {
    const normalized = this.validateColumnName(name);
    if (!normalized || !this.projectPath) return false;
    const column = { id: crypto.randomUUID(), name: normalized, color };
    return this.mutateColumn(column.id, { _tag: "AddColumn", column });
  }

  async updateColumn(columnId: string, input: { name?: string; color?: ProjectWorkflowColor }) {
    const name =
      input.name === undefined ? undefined : this.validateColumnName(input.name, columnId);
    if (input.name !== undefined && !name) return false;
    return this.mutateColumn(columnId, {
      _tag: "UpdateColumn",
      columnId,
      ...(name === undefined ? undefined : { name }),
      ...(input.color === undefined ? undefined : { color: input.color }),
    });
  }

  moveColumn(columnId: string, index: number) {
    return this.mutateColumn(columnId, { _tag: "MoveColumn", columnId, index });
  }

  deleteColumn(columnId: string) {
    return this.mutateColumn(columnId, { _tag: "DeleteColumn", columnId });
  }

  private validateColumnName(name: string, currentColumnId?: string) {
    const validation = validateProjectWorkflowColumnName(
      { columns: this.customColumns },
      name,
      currentColumnId,
    );
    if (!validation.ok) {
      this.reportError(new Error(validation.message));
      return undefined;
    }
    return validation.name;
  }

  private reportError(error: unknown) {
    this.error = error instanceof Error ? error.message : String(error);
    this.props.reportError(error);
  }

  private async mutate(mutation: ProjectWorkflowMutation, explicitProjectPath?: string) {
    const projectPath = explicitProjectPath ?? this.projectPath;
    if (!projectPath || this.signal.aborted) return false;
    this.error = undefined;
    try {
      await this.client.projectWorkflow.mutate({ projectPath, mutation }, { signal: this.signal });
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return false;
    }
  }

  private async mutateColumn(columnId: string, mutation: ProjectWorkflowMutation) {
    if (this.pendingColumnIds.has(columnId)) return false;
    this.pendingColumnIds.add(columnId);
    try {
      return await this.mutate(mutation);
    } finally {
      this.pendingColumnIds.delete(columnId);
    }
  }

  async moveSession(sessionId: string, destination: KanbanColumnId) {
    const session = this.props.catalog.find(sessionId);
    if (!session) return false;
    const projectPath = session.projectPath;
    const project = this.props.projects.find(projectPath);
    if (!project || this.pendingSessionIds.has(sessionId)) return false;
    if (
      destination !== "draft" &&
      destination !== "active" &&
      destination !== "resolved" &&
      !project.workflow.columns.some((column) => column.id === destination)
    ) {
      this.reportError(new Error("That custom status no longer exists"));
      return false;
    }
    const source = this.columnForSession(sessionId);
    if (source === destination) return true;
    if (destination === "draft") {
      this.reportError(new Error("An existing session cannot be moved back to Draft"));
      return false;
    }
    if (source === "draft" && destination === "resolved") {
      this.reportError(new Error("Activate a Draft before resolving it"));
      return false;
    }
    const familyChild =
      Boolean(session.familyParentSessionId) && session.familyParentSessionId !== session.sessionId;
    if ((source === "resolved" || destination === "resolved") && familyChild) {
      this.reportError(new Error("Resolve or restore this Session Family from its parent card"));
      return false;
    }

    this.pendingSessionIds.add(sessionId);
    this.error = undefined;
    try {
      if (source === "draft") {
        const draft = this.props.registry.findSession(sessionId);
        if (!draft || !(await draft.chatStore.activateDraft())) return false;
      }

      await this.client.projectWorkflow.moveSession(
        {
          projectPath,
          sessionId,
          workingDirectory: session.workingDirectory,
          destination:
            destination === "resolved"
              ? { _tag: "Resolved" }
              : destination === "active"
                ? { _tag: "Active" }
                : { _tag: "Custom", statusId: destination },
        },
        { signal: this.signal },
      );
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return false;
    } finally {
      this.pendingSessionIds.delete(sessionId);
    }
  }
}
