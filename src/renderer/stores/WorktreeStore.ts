import { Store, untracked } from "r-state-tree";
import type { WorktreeLandingOperation } from "../../domain/worktree-landing-data";
import type {
  WorktreeLandRequest,
  WorktreeRecord,
  WorktreeStatus,
} from "../../ipc/worktree-contract";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";

const POLL_INTERVAL_MS = 5_000;

export interface WorktreeStoreProps {
  workspacePath(): string | undefined;
  sessionId(): string | undefined;
  enabled(): boolean;
  isStreaming(): boolean;
  onLanded(record: WorktreeRecord): Promise<void> | void;
  onDiscarded(record: WorktreeRecord): Promise<void> | void;
  prepareWorkingDirectoryRetirement(workingDirectory: string): Promise<boolean>;
  onResolveWorkspace(
    workspacePath: string,
    options?: { workingDirectoryRetired?: boolean },
  ): Promise<void> | void;
}

/** Owns window-local Managed Worktree action and progress presentation. */
export class WorktreeStore extends Store<WorktreeStoreProps> {
  get managedWorktrees() {
    return ClientContext.consume(this)!.managedWorktrees;
  }

  status: WorktreeStatus | undefined;
  phase:
    | "idle"
    | "committing"
    | "waiting"
    | "landing"
    | "rebasing"
    | "proposing"
    | "resolving"
    | "resolving-rebase"
    | "resolving-session"
    | "discarding" = "idle";
  error: string | undefined;
  stalled = false;

  private operationId: string | undefined;
  private pendingResolveAfterLanding = false;
  private readonly refreshingWorkspacePaths = new Set<string>();
  private observedWorkspacePath: string | undefined;
  private completedOperationId: string | undefined;

  constructor(props: WorktreeStore["props"]) {
    super(props);
    this.effect(() => {
      if (!this.shouldPoll) return;
      const workspacePath = this.props.workspacePath();
      if (!workspacePath) return;
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = async () => {
        await this.refresh(workspacePath);
        if (!active || this.signal.aborted) return;
        timer = setTimeout(() => void poll(), this.isBusy ? 250 : POLL_INTERVAL_MS);
      };
      untracked(() => void poll());
      return () => {
        active = false;
        if (timer !== undefined) clearTimeout(timer);
      };
    });
  }

  private get shouldPoll() {
    return this.props.enabled() || this.isBusy;
  }

  get isBusy() {
    return this.phase !== "idle";
  }

  get isSessionRunning() {
    return this.props.isStreaming();
  }

  async refresh(requestedWorkspacePath?: string) {
    if (!this.shouldPoll || this.signal.aborted) return;
    const workspacePath = requestedWorkspacePath ?? this.props.workspacePath();
    const sessionId = this.props.sessionId();
    if (!workspacePath || !sessionId || this.refreshingWorkspacePaths.has(workspacePath)) return;
    if (workspacePath !== this.observedWorkspacePath) {
      this.observedWorkspacePath = workspacePath;
      this.status = undefined;
      this.phase = "idle";
      this.operationId = undefined;
      this.pendingResolveAfterLanding = false;
      this.stalled = false;
      this.error = undefined;
      this.completedOperationId = undefined;
    }
    this.refreshingWorkspacePaths.add(workspacePath);
    try {
      const snapshot = await this.managedWorktrees.landing({ workspacePath, sessionId });
      if (this.signal.aborted || this.props.workspacePath() !== workspacePath) return;
      this.status = snapshot.status;
      await this.applyOperation(snapshot.operation, workspacePath);
    } catch {
      // Transient Git or transport failures surface through the next poll.
    } finally {
      this.refreshingWorkspacePaths.delete(workspacePath);
    }
  }

  async commitAndMerge(allowDirtyTarget = false, resolveAfterLanding = false): Promise<void> {
    this.assertCanStart();
    const workspacePath = this.requiredWorkspacePath();
    const sessionId = this.requiredSessionId();
    this.pendingResolveAfterLanding = resolveAfterLanding;
    this.phase = "waiting";
    this.stalled = false;
    this.error = undefined;
    try {
      const operation = await this.managedWorktrees.startLanding({
        operationId: crypto.randomUUID(),
        workspacePath,
        sessionId,
        strategy: "preserve",
        allowDirtyTarget,
        commitBeforeLanding: true,
      });
      this.applyOperationPresentation(operation);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async land(request: WorktreeLandRequest = { strategy: "preserve" }): Promise<void> {
    this.assertCanStart();
    const workspacePath = this.requiredWorkspacePath();
    const sessionId = this.requiredSessionId();
    this.phase = "landing";
    this.stalled = false;
    this.error = undefined;
    try {
      const operation = await this.managedWorktrees.startLanding({
        operationId: crypto.randomUUID(),
        workspacePath,
        sessionId,
        strategy: request.strategy,
        allowDirtyTarget: request.allowDirtyTarget === true,
        commitBeforeLanding: false,
      });
      this.applyOperationPresentation(operation);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async rebase(): Promise<void> {
    this.assertCanStart();
    const workspacePath = this.requiredWorkspacePath();
    const sessionId = this.requiredSessionId();
    this.phase = "rebasing";
    this.stalled = false;
    this.error = undefined;
    try {
      const operation = await this.managedWorktrees.startRebase({
        operationId: crypto.randomUUID(),
        workspacePath,
        sessionId,
      });
      this.applyOperationPresentation(operation);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async retryLanding() {
    if (!this.stalled) return;
    const workspacePath = this.requiredWorkspacePath();
    const sessionId = this.requiredSessionId();
    this.stalled = false;
    this.error = undefined;
    try {
      const operation = await this.managedWorktrees.retryLanding({
        operationId: crypto.randomUUID(),
        workspacePath,
        sessionId,
      });
      this.applyOperationPresentation(operation);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async cancelLanding() {
    if (!this.operationId) return;
    const workspacePath = this.requiredWorkspacePath();
    const operationId = this.operationId;
    this.operationId = undefined;
    this.phase = "idle";
    this.stalled = false;
    this.pendingResolveAfterLanding = false;
    await this.managedWorktrees.cancelLanding({ operationId, workspacePath });
  }

  async resolve() {
    const workspacePath = this.requiredWorkspacePath();
    if (this.isBusy) throw new Error("A worktree operation is already in progress.");
    this.phase = "resolving-session";
    this.error = undefined;
    try {
      await this.props.onResolveWorkspace(workspacePath);
      if (!this.signal.aborted) this.phase = "idle";
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async discard(keepUnmergedBranch: boolean, resolve = false) {
    const workspacePath = this.requiredWorkspacePath();
    if (this.isBusy) throw new Error("A worktree operation is already in progress.");
    const record = this.status?.record;
    this.phase = "discarding";
    this.error = undefined;
    try {
      if (!(await this.props.prepareWorkingDirectoryRetirement(workspacePath))) {
        if (!this.signal.aborted) this.phase = "idle";
        return;
      }
      if (this.signal.aborted) return;
      await this.managedWorktrees.discard({
        operationId: crypto.randomUUID(),
        workspacePath,
        keepBranch: keepUnmergedBranch,
      });
      if (this.signal.aborted || this.props.workspacePath() !== workspacePath) return;
      this.status = undefined;
      this.phase = "idle";
      this.stalled = false;
      if (record) await this.props.onDiscarded({ ...record, state: "discarded" });
      if (resolve)
        await this.props.onResolveWorkspace(workspacePath, { workingDirectoryRetired: true });
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private async applyOperation(
    operation: WorktreeLandingOperation | undefined,
    workspacePath: string,
  ) {
    if (!operation) {
      if (this.phase !== "discarding" && this.phase !== "resolving-session") this.phase = "idle";
      this.operationId = undefined;
      this.stalled = false;
      return;
    }
    this.applyOperationPresentation(operation);
    if (operation.phase === "landed" && this.completedOperationId !== operation.operationId) {
      this.completedOperationId = operation.operationId;
      await this.finishLanded(workspacePath, operation.operationId);
    } else if (operation.phase === "complete") {
      await this.managedWorktrees.cancelLanding({
        operationId: operation.operationId,
        workspacePath,
      });
      if (!this.signal.aborted) {
        this.operationId = undefined;
        this.phase = "idle";
        await this.refresh(workspacePath);
      }
    }
  }

  private applyOperationPresentation(operation: WorktreeLandingOperation) {
    this.operationId = operation.operationId;
    this.stalled = operation.phase === "stalled";
    if (operation.phase === "failed") {
      this.phase = "idle";
      this.error = operation.error;
      return;
    }
    if (operation.phase === "stalled") {
      this.phase =
        operation.pauseReason === "commit"
          ? "committing"
          : operation.pauseReason === "squash-message"
            ? "proposing"
            : operation.pauseReason === "rebase-conflict"
              ? "resolving-rebase"
              : "resolving";
      return;
    }
    if (operation.phase === "landed" || operation.phase === "complete") {
      this.phase = "idle";
      return;
    }
    this.phase = operation.phase;
  }

  private async finishLanded(workspacePath: string, operationId: string) {
    const currentStatus = this.status;
    const resolveAfterLanding = this.pendingResolveAfterLanding;
    this.phase = "idle";
    this.stalled = false;
    this.pendingResolveAfterLanding = false;
    if (currentStatus) {
      const record = { ...currentStatus.record, state: "landed" as const };
      Reflect.deleteProperty(record, "pendingStrategy");
      this.status = { ...currentStatus, merged: true, record };
      await this.props.onLanded(record);
    }
    await this.managedWorktrees.cancelLanding({ operationId, workspacePath });
    this.operationId = undefined;
    if (resolveAfterLanding && this.props.workspacePath() === workspacePath) await this.resolve();
  }

  private assertCanStart() {
    if (this.isBusy) throw new Error("A worktree operation is already in progress.");
    if (this.props.isStreaming()) throw new Error("Wait for the current reply to finish first.");
  }

  private fail(error: unknown) {
    if (this.signal.aborted) return;
    this.error = describeError(error).message;
    this.phase = "idle";
    this.pendingResolveAfterLanding = false;
    this.stalled = false;
  }

  private requiredWorkspacePath() {
    const workspacePath = this.props.workspacePath();
    if (!workspacePath) throw new Error("No project session is open");
    return workspacePath;
  }

  private requiredSessionId() {
    const sessionId = this.props.sessionId();
    if (!sessionId) throw new Error("Cake could not find the Project Session");
    return sessionId;
  }
}
