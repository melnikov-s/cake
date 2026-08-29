import { Store, untracked } from "r-state-tree";
import type { DesktopClient } from "../desktop-client";
import { describeError } from "../error-details";
import type { WorktreeLandOutcome, WorktreeStatus } from "../../ipc/worktree-contract";

const POLL_INTERVAL_MS = 5_000;

export interface WorktreeStoreProps {
  client: Pick<
    DesktopClient,
    | "getWorkspaceGitStatus"
    | "getWorktreeStatus"
    | "commitWorkspace"
    | "landWorktree"
    | "discardWorktree"
    | "submit"
  >;
  workspacePath(): string | undefined;
  sessionId(): string | undefined;
  sessionTitle(): string;
  isStreaming(): boolean;
  onLanded(workspacePath: string, projectPath: string): Promise<void> | void;
  onResolveWorkspace(workspacePath: string): Promise<void> | void;
}

/** Owns Git status, commit, landing, conflict resolution, and cleanup for the selected session. */
export class WorktreeStore extends Store<WorktreeStoreProps> {
  status: WorktreeStatus | undefined;
  workspaceDirtyCount = 0;
  phase: "idle" | "committing" | "landing" | "resolving" | "discarding" = "idle";
  error: string | undefined;

  private autoRetryLanding = false;
  private refreshing = false;
  private observedWorkspacePath: string | undefined;

  constructor(props: WorktreeStore["props"]) {
    super(props);
    this.effect(() => {
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = async () => {
        await this.refresh();
        if (!active || this.signal.aborted) return;
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      };
      untracked(() => void poll());
      return () => {
        active = false;
        if (timer !== undefined) clearTimeout(timer);
      };
    });
  }

  get isBusy() {
    return this.phase !== "idle";
  }

  get isWorktree() {
    return this.status !== undefined;
  }

  get canLand() {
    return (
      this.status !== undefined &&
      !this.isBusy &&
      !this.props.isStreaming() &&
      this.status.dirtyCount === 0 &&
      (this.status.aheadCount > 0 || this.status.merged) &&
      !this.status.targetDirty &&
      this.status.targetOnBranch
    );
  }

  async refresh() {
    if (this.refreshing || this.signal.aborted) return;
    const workspacePath = this.props.workspacePath();
    if (!workspacePath) return;
    if (workspacePath !== this.observedWorkspacePath) {
      this.observedWorkspacePath = workspacePath;
      this.status = undefined;
      this.workspaceDirtyCount = 0;
      this.phase = "idle";
      this.autoRetryLanding = false;
    }
    this.refreshing = true;
    try {
      const [status, gitStatus] = await Promise.all([
        this.props.client.getWorktreeStatus({ workspacePath }),
        this.props.client.getWorkspaceGitStatus({ workspacePath }),
      ]);
      if (this.signal.aborted || this.props.workspacePath() !== workspacePath) return;
      this.status = status;
      this.workspaceDirtyCount = gitStatus.dirtyCount;
      if (!status) {
        this.phase = "idle";
        return;
      }
      await this.maybeAutoRetry(status);
    } catch {
      // Transient Git or transport failures surface through the next poll.
    } finally {
      if (!this.signal.aborted) this.refreshing = false;
    }
  }

  async commit(options: { resolve?: boolean; land?: boolean } = {}) {
    const workspacePath = this.requiredWorkspacePath();
    if (this.isBusy) throw new Error("A Git operation is already in progress.");
    if (this.props.isStreaming()) throw new Error("Wait for the current reply to finish first.");
    this.phase = "committing";
    this.error = undefined;
    try {
      await this.props.client.commitWorkspace({
        operationId: crypto.randomUUID(),
        workspacePath,
        message: this.props.sessionTitle().trim() || "Commit Cake session changes",
      });
      if (this.signal.aborted || this.props.workspacePath() !== workspacePath) return;
      await this.refreshAfterOperation(workspacePath);
      if (options.land && this.status) {
        this.phase = "idle";
        await this.land();
      } else {
        this.phase = "idle";
        if (options.resolve) await this.props.onResolveWorkspace(workspacePath);
      }
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  /** Lands as one local squash commit; semantic conflicts are delegated to the session agent. */
  async land(message?: string): Promise<WorktreeLandOutcome> {
    const workspacePath = this.requiredWorkspacePath();
    if (this.isBusy) throw new Error("A worktree operation is already in progress.");
    if (this.props.isStreaming()) throw new Error("Wait for the current reply to finish first.");
    this.phase = "landing";
    this.error = undefined;
    try {
      const outcome = await this.props.client.landWorktree({
        operationId: crypto.randomUUID(),
        workspacePath,
        message,
        autoResolve: true,
      });
      if (this.signal.aborted || this.props.workspacePath() !== workspacePath) return outcome;
      if (outcome.outcome === "resolving") {
        this.phase = "resolving";
        this.autoRetryLanding = true;
        await this.requestConflictResolution(outcome.files);
      } else {
        const projectPath = this.status?.record.projectPath;
        this.phase = "idle";
        this.status = undefined;
        this.workspaceDirtyCount = 0;
        if (projectPath) await this.props.onLanded(workspacePath, projectPath);
      }
      return outcome;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async discard(keepUnmergedBranch: boolean, resolve = false) {
    const workspacePath = this.requiredWorkspacePath();
    if (this.isBusy) throw new Error("A worktree operation is already in progress.");
    this.phase = "discarding";
    this.error = undefined;
    try {
      await this.props.client.discardWorktree({
        operationId: crypto.randomUUID(),
        workspacePath,
        keepBranch: keepUnmergedBranch,
      });
      if (this.signal.aborted || this.props.workspacePath() !== workspacePath) return;
      this.status = undefined;
      this.workspaceDirtyCount = 0;
      this.phase = "idle";
      if (resolve) await this.props.onResolveWorkspace(workspacePath);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private async refreshAfterOperation(workspacePath: string) {
    const [status, gitStatus] = await Promise.all([
      this.props.client.getWorktreeStatus({ workspacePath }),
      this.props.client.getWorkspaceGitStatus({ workspacePath }),
    ]);
    if (this.signal.aborted || this.props.workspacePath() !== workspacePath) return;
    this.status = status;
    this.workspaceDirtyCount = gitStatus.dirtyCount;
  }

  private fail(error: unknown) {
    if (this.signal.aborted) return;
    this.error = describeError(error).message;
    this.phase = "idle";
  }

  private async maybeAutoRetry(status: WorktreeStatus) {
    if (
      !this.autoRetryLanding ||
      this.phase !== "resolving" ||
      status.merging ||
      status.dirtyCount > 0 ||
      status.aheadCount === 0
    )
      return;
    this.autoRetryLanding = false;
    this.phase = "idle";
    await this.land();
  }

  private async requestConflictResolution(files: string[]) {
    const sessionId = this.props.sessionId();
    if (!sessionId) throw new Error("Cake could not find the session to resolve conflicts with");
    const listed =
      files.length > 0
        ? files.map((file) => `- ${file}`).join("\n")
        : "- Run `git status` to list the conflicted files.";
    await this.props.client.submit({
      operationId: crypto.randomUUID(),
      sessionId,
      delivery: "prompt",
      attachments: [],
      text: [
        `Cake is landing this worktree into ${this.status?.targetBranch ?? "its target"}.`,
        "Git stopped on conflicts in these files:",
        "",
        listed,
        "",
        "Resolve the conflicts in the working tree, preserving the intent of both sides.",
        "Then complete the in-progress merge with `git commit --no-edit`.",
        "Do not push, rebase, or switch branches. Cake will retry the deterministic landing.",
      ].join("\n"),
    });
  }

  private requiredWorkspacePath() {
    const workspacePath = this.props.workspacePath();
    if (!workspacePath) throw new Error("No project session is open");
    return workspacePath;
  }
}
