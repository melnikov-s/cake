import { Store, untracked } from "r-state-tree";
import type { DesktopClient } from "../desktop-client";
import { describeError } from "../error-details";
import type { WorktreeLandOutcome, WorktreeStatus } from "../../ipc/worktree-contract";

const POLL_INTERVAL_MS = 5_000;

export interface WorktreeStoreProps {
  client: Pick<DesktopClient, "getWorktreeStatus" | "landWorktree" | "discardWorktree" | "submit">;
  /** The active session's workspace path, or undefined when no session is open. */
  workspacePath(): string | undefined;
  sessionId(): string | undefined;
  isStreaming(): boolean;
  /** Invoked when a worktree lands successfully, including automatic retries. */
  onLanded(projectPath: string): void;
}

/** Owns the managed-worktree workflow for the active project session. */
export class WorktreeStore extends Store<WorktreeStoreProps> {
  status: WorktreeStatus | undefined;
  phase: "idle" | "landing" | "resolving" | "discarding" = "idle";
  error: string | undefined;

  private autoRetryLanding = false;
  private refreshing = false;

  constructor(props: WorktreeStore["props"]) {
    super(props);
    this.effect(() => {
      untracked(() => {
        void this.refresh();
      });
      const timer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
      return () => clearInterval(timer);
    });
  }

  get isAttached() {
    return this.status !== undefined;
  }

  get isBusy() {
    return this.phase !== "idle";
  }

  get canLand() {
    return (
      this.status !== undefined &&
      !this.isBusy &&
      !this.props.isStreaming() &&
      this.status.dirtyCount === 0 &&
      (this.status.aheadCount > 0 || this.status.merged) &&
      !this.status.canonicalDirty &&
      this.status.canonicalOnBaseBranch
    );
  }

  async refresh() {
    if (this.refreshing) return;
    const workspacePath = this.props.workspacePath();
    if (!workspacePath) return;
    this.refreshing = true;
    try {
      const status = await this.props.client.getWorktreeStatus({ workspacePath });
      if (this.props.workspacePath() !== workspacePath) return;
      this.status = status;
      if (!status) {
        this.phase = "idle";
        return;
      }
      await this.maybeAutoRetry(status);
    } catch {
      // Transient Git or transport failures surface through the next poll.
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Lands the worktree branch into its base branch as one squash commit and
   * removes the worktree. Conflicts are handed to the session agent to resolve,
   * after which landing retries automatically.
   */
  async land(message?: string): Promise<WorktreeLandOutcome> {
    const workspacePath = this.requiredWorkspacePath();
    if (this.props.isStreaming())
      throw new Error("Wait for the current reply to finish before landing.");
    this.phase = "landing";
    this.error = undefined;
    try {
      const outcome = await this.props.client.landWorktree({
        operationId: crypto.randomUUID(),
        workspacePath,
        message,
        autoResolve: true,
      });
      if (outcome.outcome === "resolving") {
        this.phase = "resolving";
        this.autoRetryLanding = true;
        await this.requestConflictResolution(outcome.files);
      } else {
        const projectPath = this.status?.record.projectPath;
        this.phase = "idle";
        this.status = undefined;
        if (projectPath) this.props.onLanded(projectPath);
      }
      return outcome;
    } catch (error) {
      const described = describeError(error);
      this.error = described.message;
      this.phase = "idle";
      throw error;
    }
  }

  /** Deletes the worktree; keeps the branch when its commits were never merged. */
  async discard(keepUnmergedBranch: boolean) {
    const workspacePath = this.requiredWorkspacePath();
    this.phase = "discarding";
    this.error = undefined;
    try {
      await this.props.client.discardWorktree({
        operationId: crypto.randomUUID(),
        workspacePath,
        keepBranch: keepUnmergedBranch,
      });
      this.status = undefined;
      this.phase = "idle";
    } catch (error) {
      const described = describeError(error);
      this.error = described.message;
      this.phase = "idle";
      throw error;
    }
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
        "A merge from the base branch was started in this worktree to land your work,",
        "and Git stopped on conflicts in these files:",
        "",
        listed,
        "",
        "Resolve the conflicts in the working tree, preserving the intent of both sides.",
        "Then complete the in-progress merge with `git commit --no-edit`.",
        "Do not push, rebase, or switch branches.",
      ].join("\n"),
    });
  }

  private requiredWorkspacePath() {
    const workspacePath = this.props.workspacePath();
    if (!workspacePath) throw new Error("No project session is open");
    return workspacePath;
  }
}
