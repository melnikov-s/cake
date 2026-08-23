import { Store } from "r-state-tree";
import type { DesktopClient } from "../desktop-client";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface WorktreeCreationStoreProps {
  client: Pick<DesktopClient, "createWorktree">;
  operations: SessionOperationCoordinatorStore;
  catalog: SessionCatalogStore;
  openCreatedWorktree(worktreePath: string, projectPath: string): Promise<void> | void;
  reportError(error: unknown): void;
}

/** Owns worktree-session confirmation and managed-worktree creation. */
export class WorktreeCreationStore extends Store<WorktreeCreationStoreProps> {
  promptPath: string | undefined;

  request(path: string | undefined) {
    if (path) this.promptPath = path;
  }

  cancel() {
    this.promptPath = undefined;
  }

  async confirm() {
    const path = this.promptPath;
    this.promptPath = undefined;
    if (!path || this.signal.aborted) return;
    const operationId = this.props.operations.start("project-workbench");
    try {
      const record = await this.props.client.createWorktree({ operationId, path });
      if (this.signal.aborted) return;
      this.props.catalog.noteManagedWorktree(record.worktreePath, record.projectPath);
      await this.props.openCreatedWorktree(record.worktreePath, record.projectPath);
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
    } finally {
      this.props.operations.finish(operationId);
    }
  }
}
