import { Store, observable } from "r-state-tree";
import type { WorktreeRecord } from "../../ipc/worktree-contract";
import { RendererClientContext } from "../client/RendererClientContext";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export type WorktreeDraftChoice =
  | { kind: "current" }
  | { kind: "new"; baseWorktreePath?: string }
  | { kind: "reuse"; worktreePath: string };

export type ExistingWorktreeCandidate = WorktreeRecord & { sessionTitle: string };

export interface WorktreeCreationStoreProps {
  operations: SessionOperationCoordinatorStore;
  catalog: SessionCatalogStore;
  relocateTemporarySession(sessionId: string, workspacePath: string): void;
  reportError(error: unknown): void;
}

/** Owns draft-only worktree selection and first-send checkout preparation. */
export class WorktreeCreationStore extends Store<WorktreeCreationStoreProps> {
  get managedWorktrees() {
    return RendererClientContext.consume(this)!.managedWorktrees;
  }

  private readonly choicesBySession: Record<string, WorktreeDraftChoice> = observable({});
  preparingSessionId: string | undefined;

  choice(sessionId: string): WorktreeDraftChoice {
    return this.choicesBySession[sessionId] ?? { kind: "current" };
  }

  select(sessionId: string, choice: WorktreeDraftChoice) {
    if (this.preparingSessionId === sessionId) return;
    this.choicesBySession[sessionId] = choice;
  }

  clear(sessionId: string) {
    delete this.choicesBySession[sessionId];
  }

  /** Active managed worktrees, paired with their most recently active session. */
  candidates(projectPath: string): ExistingWorktreeCandidate[] {
    const records = new Map<string, ExistingWorktreeCandidate>();
    for (const session of this.props.catalog.projectSessions(projectPath)) {
      const record = this.props.catalog.managedWorktree(session.workingDirectory);
      if (record && (record.state ?? "active") === "active" && !records.has(record.worktreePath))
        records.set(record.worktreePath, { ...record, sessionTitle: session.title });
    }
    return [...records.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  /** Creates a managed checkout for a session-creation workflow outside the draft UI. */
  async create(
    projectPath: string,
    options?: { name?: string; baseWorktreePath?: string },
  ): Promise<WorktreeRecord> {
    const operationId = this.props.operations.start("project-workbench");
    try {
      const record = await this.managedWorktrees.create({
        operationId,
        path: projectPath,
        baseWorktreePath: options?.baseWorktreePath,
        worktreeName: options?.name,
      });
      if (this.signal.aborted) throw new Error("Worktree creation was cancelled.");
      this.props.catalog.noteManagedWorktree(record);
      return record;
    } finally {
      this.props.operations.finish(operationId);
    }
  }

  /**
   * Repeated calls are ignored while checkout preparation is active. A failure
   * leaves the draft and its selection intact so the user can retry or choose again.
   */
  async prepare(
    sessionId: string,
    projectPath: string,
    firstUserMessage: string,
  ): Promise<boolean> {
    const choice = this.choice(sessionId);
    if (choice.kind === "current") return true;
    if (this.preparingSessionId) return false;
    this.preparingSessionId = sessionId;
    const operationId = this.props.operations.start("project-workbench");
    try {
      let workspacePath: string;
      if (choice.kind === "reuse") {
        const record = this.props.catalog.managedWorktree(choice.worktreePath);
        if (
          !record ||
          (record.state ?? "active") !== "active" ||
          record.projectPath !== projectPath
        )
          throw new Error("That worktree is no longer available.");
        workspacePath = record.worktreePath;
      } else {
        const record = await this.managedWorktrees.create({
          operationId,
          path: projectPath,
          baseWorktreePath: choice.baseWorktreePath,
          firstUserMessage: firstUserMessage.trim() || undefined,
        });
        if (this.signal.aborted) return false;
        this.props.catalog.noteManagedWorktree(record);
        workspacePath = record.worktreePath;
      }
      if (this.signal.aborted) return false;
      this.props.relocateTemporarySession(sessionId, workspacePath);
      this.choicesBySession[sessionId] = { kind: "reuse", worktreePath: workspacePath };
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
      return false;
    } finally {
      if (!this.signal.aborted) this.preparingSessionId = undefined;
      this.props.operations.finish(operationId);
    }
  }
}
