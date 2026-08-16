import { Store, observable } from "r-state-tree";
import type { ChangedFile } from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionOperationCoordinator } from "./SessionOperationCoordinator";

export interface ChangesStoreProps {
  client: Pick<DesktopClient, "inspectChanges">;
  projectPath(): string | undefined;
  sessionId(): string | undefined;
  operations: SessionOperationCoordinator;
}

/** Owns the Git-backed workspace-changes surface and its refresh policy. */
export class ChangesStore extends Store<ChangesStoreProps> {
  changes: ChangedFile[] = observable([]);
  path: string | null | undefined;
  loading = false;
  error: string | undefined;
  private activeOperationId: string | undefined;
  private refreshPending = false;
  private preferredPath: string | undefined;

  get selected() {
    if (this.path == null) return this.changes[0];
    return this.changeForPath(this.path) ?? this.changes[0];
  }

  async open(path?: string) {
    this.preferredPath = path;
    this.path = this.changeForPath(path)?.path ?? path ?? this.changes[0]?.path ?? null;
    await this.refresh();
  }

  async refresh() {
    const workspacePath = this.props.projectPath();
    const sessionId = this.props.sessionId();
    if (!workspacePath || !sessionId) return;
    if (this.activeOperationId) {
      this.refreshPending = true;
      return;
    }
    const operationId = this.props.operations.start();
    this.activeOperationId = operationId;
    this.loading = true;
    this.error = undefined;
    try {
      await this.props.client.inspectChanges({ operationId, workspacePath, sessionId });
    } catch (error) {
      if (this.activeOperationId !== operationId) return;
      this.error = errorMessage(error);
      this.finishRefresh(operationId);
    }
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "pi-state-changed" && (event.state === "failed" || event.state === "stopped")) {
      if (this.activeOperationId) this.finishRefresh(this.activeOperationId);
      return;
    }
    if (event.type === "changes-received") {
      if (event.operationId !== this.activeOperationId || event.workspacePath !== this.props.projectPath() || event.sessionId !== this.props.sessionId()) return;
      const wasOpen = this.path !== undefined;
      this.changes.splice(0, this.changes.length, ...event.files);
      const requested = this.preferredPath;
      this.preferredPath = undefined;
      if (wasOpen) {
        const selected = this.changeForPath(requested ?? this.path ?? undefined);
        this.path = selected?.path ?? this.changes[0]?.path ?? null;
      }
      this.error = undefined;
      this.finishRefresh(event.operationId);
      return;
    }
    if (event.type === "operation-failed" && event.operationId && event.operationId === this.activeOperationId) {
      this.error = event.message;
      this.finishRefresh(event.operationId);
    }
  }

  select(path: string) {
    const change = this.changeForPath(path);
    if (change) this.path = change.path;
  }

  focusPath(path: string) {
    this.preferredPath = path;
    this.path = this.changeForPath(path)?.path ?? path;
  }

  changeMatchesPath(change: ChangedFile, path: string) {
    return change.path === path || change.previousPath === path;
  }

  close() {
    this.path = undefined;
    this.preferredPath = undefined;
  }

  reset() {
    this.close();
    this.changes.splice(0);
    this.loading = false;
    this.error = undefined;
    this.activeOperationId = undefined;
    this.refreshPending = false;
  }

  private changeForPath(path?: string | null) {
    return path == null ? undefined : this.changes.find((change) => this.changeMatchesPath(change, path));
  }

  private finishRefresh(operationId: string) {
    if (this.activeOperationId !== operationId) return;
    this.activeOperationId = undefined;
    this.loading = false;
    this.props.operations.finish(operationId);
    if (!this.refreshPending) return;
    this.refreshPending = false;
    void this.refresh();
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
