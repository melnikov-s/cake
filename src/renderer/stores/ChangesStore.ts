import { Store, observable } from "r-state-tree";
import type { ChangedFile, UiPart } from "../../ipc/session-contract";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import { workLogTurns, type ChangeSource, type WorkLogTurn } from "../../utils/turn-diff";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import { errorMessage } from "../../utils/error-message";

export interface ChangesStoreProps {
  client: Pick<DesktopClient, "inspectChanges">;
  projectPath(): string | undefined;
  sessionId(): string | undefined;
  parts(): readonly UiPart[];
  operations: SessionOperationCoordinatorStore;
}

/** Owns the Git-backed workspace-changes surface and its refresh policy. */
export class ChangesStore extends Store<ChangesStoreProps> {
  changes: ChangedFile[] = observable([]);
  workingTreeCount = 0;
  source: ChangeSource = "working-tree";
  selectedTurnId: string | undefined;
  path: string | null | undefined;
  loading = false;
  error: string | undefined;
  private activeOperationId: string | undefined;
  private refreshPending = false;
  private preferredPath: string | undefined;

  get turns(): WorkLogTurn[] {
    return workLogTurns(this.props.parts());
  }

  get selectedTurn() {
    return this.turns.find((turn) => turn.id === this.selectedTurnId);
  }

  get visibleChanges() {
    return this.source === "conversation-turn" ? (this.selectedTurn?.changes ?? []) : this.changes;
  }

  get selected() {
    if (this.path == null) return this.visibleChanges[0];
    return this.changeForPath(this.path) ?? this.visibleChanges[0];
  }

  async open(path?: string) {
    this.preferredPath = path;
    this.path = this.changeForPath(path)?.path ?? path ?? this.visibleChanges[0]?.path ?? null;
    if (this.source === "conversation-turn") return;
    await this.refresh();
  }

  async refresh() {
    if (this.source === "conversation-turn") return;
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
      await this.props.client.inspectChanges({ operationId, sessionId });
    } catch (error) {
      if (this.activeOperationId !== operationId) return;
      this.error = errorMessage(error);
      this.finishRefresh(operationId);
    }
  }

  receive(event: DesktopClientEvent) {
    if (
      event.type === "pi-state-changed" &&
      (event.state === "failed" || event.state === "stopped")
    ) {
      if (this.activeOperationId) this.finishRefresh(this.activeOperationId);
      return;
    }
    if (event.type === "changes-received") {
      if (
        event.operationId !== this.activeOperationId ||
        event.workspacePath !== this.props.projectPath() ||
        event.sessionId !== this.props.sessionId()
      )
        return;
      const wasOpen = this.path !== undefined;
      this.changes.splice(0, this.changes.length, ...event.files);
      this.workingTreeCount = event.files.length;
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
    if (
      event.type === "operation-failed" &&
      event.operationId &&
      event.operationId === this.activeOperationId
    ) {
      this.error = event.message;
      this.finishRefresh(event.operationId);
    }
  }

  select(path: string) {
    const change = this.changeForPath(path);
    if (change) this.path = change.path;
  }

  async selectSource(source: ChangeSource) {
    if (source === this.source) return;
    this.source = source;
    this.path = null;
    this.preferredPath = undefined;
    if (source === "conversation-turn") {
      this.selectedTurnId = this.turns.at(-1)?.id;
      this.error = undefined;
      this.loading = false;
      return;
    }
    this.selectedTurnId = undefined;
    this.path = this.changes[0]?.path ?? null;
    await this.refresh();
  }

  selectTurn(turnId: string) {
    if (this.source !== "conversation-turn" || turnId === this.selectedTurnId) return;
    if (!this.turns.some((turn) => turn.id === turnId)) return;
    this.selectedTurnId = turnId;
    this.path = this.selectedTurn?.changes[0]?.path ?? null;
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
    this.source = "working-tree";
    this.selectedTurnId = undefined;
    this.workingTreeCount = 0;
    this.loading = false;
    this.error = undefined;
    this.activeOperationId = undefined;
    this.refreshPending = false;
  }

  private changeForPath(path?: string | null) {
    return path == null
      ? undefined
      : this.visibleChanges.find((change) => this.changeMatchesPath(change, path));
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
