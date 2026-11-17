import { observable, Store } from "r-state-tree";
import type { WorktreeOperationCatalog } from "../models/WorktreeOperationCatalog";
import { ClientContext } from "./context/ClientContext";
import { ToastContext } from "./context/ToastContext";

/** Window-local submission state; only the backend projection grants authorization. */
export class AutoMergeStore extends Store<{ operations: WorktreeOperationCatalog }> {
  private readonly pending = observable(new Map<string, boolean>());

  forProject(projectPath: string) {
    return this.props.operations.autoMergeProjects.find((item) => item.projectPath === projectPath);
  }

  pendingTarget(projectPath: string) {
    return this.pending.get(projectPath);
  }

  async toggle(projectPath: string) {
    // Shared across every control for this project, including unmount/remount during navigation.
    if (this.signal.aborted || this.pending.has(projectPath)) return;
    const enabled = !this.forProject(projectPath)?.enabled;
    this.pending.set(projectPath, enabled);
    try {
      // Let an accepted durable write finish if the window closes; never update a disposed Store.
      await ClientContext.consume(this)!.managedWorktrees.setAutoMerge(projectPath, enabled);
    } catch (error) {
      if (!this.signal.aborted)
        ToastContext.consume(this)!.show({
          tone: "error",
          title: "Could not change auto-merge",
          message: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (!this.signal.aborted) this.pending.delete(projectPath);
    }
  }
}
