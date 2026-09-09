import { Store } from "r-state-tree";
import type { WorktreeLandingOperation } from "../../domain/worktrees/worktree-landing-data";
import type { WorktreeRecord } from "../../domain/worktrees/managed-worktree-data";
import type { WorktreeLandRequest, WorktreeStatus } from "../../ipc/worktree-contract";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";
import type { WorkingDirectoryRetirementWorkflow } from "./WorkingDirectoryRetirementStore";

export interface WorktreeStoreProps {
  workspacePath(): string | undefined;
  sessionId(): string | undefined;
  enabled(): boolean;
  isStreaming(): boolean;
  operation(): WorktreeLandingOperation | undefined;
  onLanded(record: WorktreeRecord, result: { resolved: boolean }): Promise<void> | void;
  onDiscarded(record: WorktreeRecord): Promise<void> | void;
  retirement: WorkingDirectoryRetirementWorkflow;
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
  private startedLandingOperationId: string | undefined;
  private startedResolveAfterLanding = false;
  private readonly refreshingWorkspacePaths = new Set<string>();
  private observedWorkspacePath: string | undefined;
  private completedOperationId: string | undefined;

  constructor(props: WorktreeStore["props"]) {
    super(props);
    this.reaction(
      () => this.props.operation(),
      () => {
        const workspacePath = this.props.workspacePath();
        if (workspacePath) void this.refresh(workspacePath);
      },
    );
    this.effect(() => {
      const workspacePath = this.props.workspacePath();
      if (this.props.enabled() && workspacePath) void this.refresh(workspacePath);
    });
  }

  private get shouldRefresh() {
    return this.props.enabled() || this.isBusy || this.props.operation() !== undefined;
  }

  get isBusy() {
    return this.phase !== "idle";
  }

  /** True only when main has authoritatively placed this operation behind another landing. */
  get isQueued() {
    return (
      this.phase === "waiting" &&
      this.operationId !== undefined &&
      this.status?.landingState === "queued" &&
      this.status.landingOperationId === this.operationId
    );
  }

  get isSessionRunning() {
    return this.props.isStreaming();
  }

  async refresh(requestedWorkspacePath?: string) {
    if (!this.shouldRefresh || this.signal.aborted) return;
    const workspacePath = requestedWorkspacePath ?? this.props.workspacePath();
    const sessionId = this.props.sessionId();
    if (!workspacePath || !sessionId || this.refreshingWorkspacePaths.has(workspacePath)) return;
    if (workspacePath !== this.observedWorkspacePath) {
      this.observedWorkspacePath = workspacePath;
      this.status = undefined;
      this.phase = "idle";
      this.operationId = undefined;
      this.startedLandingOperationId = undefined;
      this.startedResolveAfterLanding = false;
      this.stalled = false;
      this.error = undefined;
      this.completedOperationId = undefined;
    }
    this.refreshingWorkspacePaths.add(workspacePath);
    try {
      const snapshot = await this.managedWorktrees.landing({ workspacePath, sessionId });
      if (this.signal.aborted || this.props.workspacePath() !== workspacePath) return;
      const operation = this.props.operation();
      // Merge-and-resolve retires the worktree before publishing its terminal operation.
      // Retain the last status long enough to present that successful completion.
      if (snapshot.status || operation?.phase !== "landed") this.status = snapshot.status;
      if (operation) await this.applyOperation(operation, workspacePath);
    } catch {
      // Transient Git or transport failures surface through the next projected operation or intent.
    } finally {
      this.refreshingWorkspacePaths.delete(workspacePath);
    }
  }

  async commitAndMerge(allowDirtyTarget = false, resolveAfterLanding = false): Promise<void> {
    this.assertCanStart();
    const workspacePath = this.requiredWorkspacePath();
    const sessionId = this.requiredSessionId();
    this.phase = (this.status?.dirtyCount ?? 0) > 0 ? "committing" : "landing";
    this.stalled = false;
    this.error = undefined;
    const operationId = crypto.randomUUID();
    this.startedLandingOperationId = operationId;
    this.startedResolveAfterLanding = resolveAfterLanding;
    try {
      const operation = await this.managedWorktrees.startLanding({
        operationId,
        workspacePath,
        sessionId,
        strategy: "preserve",
        allowDirtyTarget,
        commitBeforeLanding: true,
        resolveAfterLanding,
      });
      this.startedLandingOperationId = operation.operationId;
      this.applyOperationPresentation(operation);
      await this.refresh(workspacePath);
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
    const operationId = crypto.randomUUID();
    this.startedLandingOperationId = operationId;
    this.startedResolveAfterLanding = false;
    try {
      const operation = await this.managedWorktrees.startLanding({
        operationId,
        workspacePath,
        sessionId,
        strategy: request.strategy,
        allowDirtyTarget: request.allowDirtyTarget === true,
        commitBeforeLanding: false,
        resolveAfterLanding: false,
      });
      this.startedLandingOperationId = operation.operationId;
      this.applyOperationPresentation(operation);
      await this.refresh(workspacePath);
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
      // The rebase can complete before this RPC response arrives. Reconcile after
      // applying the accepted operation so that response cannot overwrite a
      // terminal projection and leave the controls stuck in "rebasing".
      await this.refresh(workspacePath);
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
    if (!this.operationId || (!this.isQueued && !this.stalled)) return;
    const workspacePath = this.requiredWorkspacePath();
    const operationId = this.operationId;
    try {
      await this.managedWorktrees.cancelLanding({
        operationId,
        workspacePath,
        intent: "cancel",
      });
      if (this.operationId !== operationId) return;
      this.operationId = undefined;
      this.startedLandingOperationId = undefined;
      this.startedResolveAfterLanding = false;
      this.phase = "idle";
      this.stalled = false;
    } catch (error) {
      await this.refresh(workspacePath);
      if (!this.signal.aborted) this.error = describeError(error).message;
      throw error;
    }
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
      if (!(await this.props.retirement.prepare([workspacePath]))) {
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
      if (
        this.status?.record.state === "landed" &&
        this.status.aheadCount === 0 &&
        this.startedLandingOperationId
      ) {
        await this.finishLanded(
          workspacePath,
          this.startedLandingOperationId,
          this.startedResolveAfterLanding,
        );
        return;
      }
      // A snapshot requested concurrently with start may predate main's accepted operation.
      // A previously landed worktree remains landed while its additional commits are in flight,
      // so only an ahead count of zero can independently prove completion.
      if (this.startedLandingOperationId) return;
      if (this.phase !== "discarding" && this.phase !== "resolving-session") this.phase = "idle";
      this.operationId = undefined;
      this.stalled = false;
      return;
    }
    this.applyOperationPresentation(operation);
    if (operation.phase === "landed" && this.completedOperationId !== operation.operationId) {
      this.completedOperationId = operation.operationId;
      await this.finishLanded(
        workspacePath,
        operation.operationId,
        operation.resolveAfterLanding === true ||
          (this.startedLandingOperationId === operation.operationId &&
            this.startedResolveAfterLanding),
      );
    } else if (operation.phase === "complete") {
      await this.managedWorktrees.cancelLanding({
        operationId: operation.operationId,
        workspacePath,
        intent: "acknowledge",
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
    if (operation.phase === "waiting") {
      if (
        this.status?.landingState === "queued" &&
        this.status.landingOperationId === operation.operationId
      )
        this.phase = "waiting";
      else if (this.phase !== "committing") this.phase = "landing";
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

  private async finishLanded(workspacePath: string, operationId: string, resolved: boolean) {
    const currentStatus = this.status;
    this.phase = "idle";
    this.stalled = false;
    this.startedLandingOperationId = undefined;
    this.startedResolveAfterLanding = false;
    if (currentStatus) {
      const record = { ...currentStatus.record, state: "landed" as const };
      Reflect.deleteProperty(record, "pendingStrategy");
      this.status = { ...currentStatus, merged: true, record };
      await this.props.onLanded(record, { resolved });
    }
    this.operationId = undefined;
    await this.managedWorktrees.cancelLanding({
      operationId,
      workspacePath,
      intent: "acknowledge",
    });
  }

  private assertCanStart() {
    if (this.isBusy) throw new Error("A worktree operation is already in progress.");
    if (this.props.isStreaming()) throw new Error("Wait for the current reply to finish first.");
  }

  private fail(error: unknown) {
    if (this.signal.aborted) return;
    this.error = describeError(error).message;
    this.phase = "idle";
    this.startedLandingOperationId = undefined;
    this.startedResolveAfterLanding = false;
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
