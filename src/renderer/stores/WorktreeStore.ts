import { Store, untracked } from "r-state-tree";
import { describeError } from "../error-details";
import { RendererClientContext } from "../client/RendererClientContext";
import type {
  WorktreeLandOutcome,
  WorktreeLandRequest,
  WorktreeRecord,
  WorktreeStatus,
} from "../../ipc/worktree-contract";

const POLL_INTERVAL_MS = 5_000;

export interface WorktreeStoreProps {
  workspacePath(): string | undefined;
  sessionId(): string | undefined;
  enabled(): boolean;
  isStreaming(): boolean;
  onLanded(record: WorktreeRecord): Promise<void> | void;
  onDiscarded(record: WorktreeRecord): Promise<void> | void;
  onResolveWorkspace(workspacePath: string): Promise<void> | void;
}

/**
 * Owns worktree status, landing, conflict resolution, and cleanup. Landing
 * replays the branch commits onto the target by default; squash landing asks
 * the session agent for a commit message through the Cake gateway. Both flows
 * run as ordinary turns in the same session so the user sees all agent work.
 */
export class WorktreeStore extends Store<WorktreeStoreProps> {
  get managedWorktrees() {
    return RendererClientContext.consume(this)!.managedWorktrees;
  }

  get projectSessions() {
    return RendererClientContext.consume(this)!.projectSessions;
  }

  status: WorktreeStatus | undefined;
  phase:
    | "idle"
    | "committing"
    | "landing"
    | "proposing"
    | "resolving"
    | "resolving-session"
    | "discarding" = "idle";
  error: string | undefined;
  /** True when a paused landing is waiting on the user because the agent stopped without finishing. */
  stalled = false;

  private pendingStrategy: WorktreeLandRequest["strategy"] | undefined;
  private pendingAllowDirtyTarget = false;
  private pendingResolveAfterLanding = false;
  private adoptedPauseFor: string | undefined;
  private refreshing = false;
  private observedWorkspacePath: string | undefined;

  constructor(props: WorktreeStore["props"]) {
    super(props);
    this.effect(() => {
      if (!this.props.enabled()) return;
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

  get isSessionRunning() {
    return this.props.isStreaming();
  }

  async refresh() {
    if (!this.props.enabled() || this.refreshing || this.signal.aborted) return;
    const workspacePath = this.props.workspacePath();
    if (!workspacePath) return;
    if (workspacePath !== this.observedWorkspacePath) {
      this.observedWorkspacePath = workspacePath;
      this.status = undefined;
      this.phase = "idle";
      this.pendingStrategy = undefined;
      this.pendingAllowDirtyTarget = false;
      this.pendingResolveAfterLanding = false;
      this.stalled = false;
    }
    this.refreshing = true;
    try {
      const status = await this.managedWorktrees.status({ workspacePath });
      if (this.signal.aborted || this.props.workspacePath() !== workspacePath) return;
      this.status = status;
      if (!status) {
        this.phase = "idle";
        return;
      }
      if (this.adoptedPauseFor !== workspacePath) {
        this.adoptedPauseFor = workspacePath;
        this.adoptPausedLanding(status);
      }
      await this.maybeAutoRetry(status);
    } catch {
      // Transient Git or transport failures surface through the next poll.
    } finally {
      if (!this.signal.aborted) this.refreshing = false;
    }
  }

  /** Asks the session to commit dirty changes, then automatically lands the clean branch. */
  async commitAndMerge(allowDirtyTarget = false, resolveAfterLanding = false): Promise<void> {
    const workspacePath = this.requiredWorkspacePath();
    if (this.isBusy) throw new Error("A worktree operation is already in progress.");
    if (this.props.isStreaming()) throw new Error("Wait for the current reply to finish first.");
    this.pendingResolveAfterLanding = resolveAfterLanding;
    if (!this.status?.dirtyCount) {
      await this.land({ strategy: "preserve", allowDirtyTarget: allowDirtyTarget || undefined });
      return;
    }
    this.phase = "committing";
    this.pendingStrategy = "preserve";
    this.pendingAllowDirtyTarget = allowDirtyTarget;
    this.stalled = false;
    this.error = undefined;
    try {
      await this.requestCommit();
      if (this.signal.aborted || this.props.workspacePath() !== workspacePath) return;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  /** Lands with the given strategy; conflicts and squash messages are delegated to the session agent. */
  async land(
    request: WorktreeLandRequest = { strategy: "preserve" },
  ): Promise<WorktreeLandOutcome> {
    const workspacePath = this.requiredWorkspacePath();
    if (this.isBusy) throw new Error("A worktree operation is already in progress.");
    if (this.props.isStreaming()) throw new Error("Wait for the current reply to finish first.");
    this.phase = "landing";
    this.pendingStrategy = request.strategy;
    this.pendingAllowDirtyTarget = request.allowDirtyTarget === true;
    this.stalled = false;
    this.error = undefined;
    try {
      const outcome = await this.managedWorktrees.land({
        operationId: crypto.randomUUID(),
        workspacePath,
        request,
      });
      if (this.signal.aborted || this.props.workspacePath() !== workspacePath) return outcome;
      if (outcome.outcome === "resolving") {
        this.phase = "resolving";
        await this.requestConflictResolution(request.strategy, outcome.files);
      } else if (outcome.outcome === "proposal") {
        this.phase = "proposing";
        await this.requestSquashMessage();
      } else {
        await this.finishLanded(workspacePath);
      }
      return outcome;
    } catch (error) {
      this.fail(error);
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
      await this.managedWorktrees.discard({
        operationId: crypto.randomUUID(),
        workspacePath,
        keepBranch: keepUnmergedBranch,
      });
      if (this.signal.aborted || this.props.workspacePath() !== workspacePath) return;
      this.status = undefined;
      this.phase = "idle";
      this.pendingStrategy = undefined;
      this.pendingAllowDirtyTarget = false;
      this.pendingResolveAfterLanding = false;
      this.stalled = false;
      if (record) await this.props.onDiscarded({ ...record, state: "discarded" });
      if (resolve) await this.props.onResolveWorkspace(workspacePath);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  private fail(error: unknown) {
    if (this.signal.aborted) return;
    this.error = describeError(error).message;
    this.phase = "idle";
    this.pendingResolveAfterLanding = false;
    this.stalled = false;
  }

  /**
   * Resumes a paused landing after the user reviewed the paused worktree: the
   * landing either completes now or pauses again with a fresh agent request.
   */
  async retryLanding() {
    if (this.phase === "committing") {
      const allowDirtyTarget = this.pendingAllowDirtyTarget;
      const resolveAfterLanding = this.pendingResolveAfterLanding;
      this.phase = "idle";
      this.stalled = false;
      await this.commitAndMerge(allowDirtyTarget, resolveAfterLanding);
      return;
    }
    if (this.phase !== "resolving" && this.phase !== "proposing") return;
    const strategy = this.pendingStrategy;
    if (!strategy) return;
    if (this.props.isStreaming()) throw new Error("Wait for the current reply to finish first.");
    this.phase = "idle";
    this.stalled = false;
    await this.land({
      strategy,
      allowDirtyTarget: this.pendingAllowDirtyTarget || undefined,
    });
  }

  /** Releases a paused landing back to manual control without touching Git state. */
  cancelLanding() {
    if (this.phase !== "committing" && this.phase !== "resolving" && this.phase !== "proposing")
      return;
    this.phase = "idle";
    this.pendingStrategy = undefined;
    this.pendingAllowDirtyTarget = false;
    this.pendingResolveAfterLanding = false;
    this.stalled = false;
  }

  /**
   * Adopts a landing that was paused before the renderer reloaded. The service
   * records the paused strategy on the worktree, so the pause survives even
   * though this store was recreated.
   */
  private adoptPausedLanding(status: WorktreeStatus) {
    if (this.phase !== "idle" || !status.record.pendingStrategy) return;
    this.pendingStrategy = status.record.pendingStrategy;
    this.pendingAllowDirtyTarget = false;
    const pausedOnWork =
      status.dirtyCount > 0 ||
      status.merging ||
      status.rebasing ||
      status.record.pendingStrategy === "preserve";
    this.phase = pausedOnWork ? "resolving" : "proposing";
  }

  /**
   * Continues a paused landing once the session agent finished its work: the
   * worktree is clean, no rebase or merge is in progress, and — for squash —
   * the agent proposed a commit message for the current branch tip.
   */
  private async maybeAutoRetry(status: WorktreeStatus) {
    if (this.phase !== "committing" && this.phase !== "resolving" && this.phase !== "proposing")
      return;
    if (this.props.isStreaming() || !this.pendingStrategy) {
      this.stalled = false;
      return;
    }
    const blocked =
      status.dirtyCount > 0 ||
      status.merging ||
      status.rebasing ||
      status.aheadCount === 0 ||
      (this.pendingStrategy === "squash" && !status.squashMessageReady);
    if (blocked) {
      // The agent turn ended without finishing the landing; recovery is up to
      // the user (retry the request, or dismiss and act manually).
      this.stalled = true;
      return;
    }
    this.stalled = false;
    const strategy = this.pendingStrategy;
    const allowDirtyTarget = this.pendingAllowDirtyTarget || undefined;
    this.phase = "idle";
    await this.land({ strategy, allowDirtyTarget });
  }

  private async requestCommit() {
    const sessionId = this.props.sessionId();
    if (!sessionId) throw new Error("Cake could not find the session to commit with");
    const target = this.status?.targetBranch ?? "its target";
    await this.projectSessions.prompt(
      {
        sessionId,
        renderUserMessageAsMarkdown: false,
        attachments: [],
        text: [
          `Cake is preparing to merge this worktree into ${target}, but it has uncommitted changes.`,
          "",
          "Inspect the complete working tree, verify the change, and commit all intended work with an appropriate commit message.",
          "",
          "Do not merge, rebase, push, switch branches, or modify the target checkout. Cake will merge the committed branch after this turn finishes.",
        ].join("\n"),
      },
      { signal: this.signal },
    );
  }

  private async requestConflictResolution(
    strategy: WorktreeLandRequest["strategy"],
    files: ReadonlyArray<string>,
  ) {
    const sessionId = this.props.sessionId();
    if (!sessionId) throw new Error("Cake could not find the session to resolve conflicts with");
    const listed =
      files.length > 0
        ? files.map((file) => `- ${file}`).join("\n")
        : "- Run `git status` to list the conflicted files.";
    const target = this.status?.targetBranch ?? "its target";
    const text =
      strategy === "squash"
        ? [
            `Cake is preparing to squash this worktree into ${target} as one commit, but the combined change conflicts with ${target}.`,
            "Git stopped on conflicts in these files:",
            "",
            listed,
            "",
            "1. Resolve the conflicts in the working tree, preserving the intent of both sides.",
            "2. Complete the in-progress merge with `git commit --no-edit`.",
            `3. Inspect the complete change against ${target}, then propose one commit message for it with the Cake \`worktrees.proposeSquashMessage\` tool (a subject and optional body).`,
            "",
            "Do not push, rebase, or switch branches, and do not touch the target checkout. Cake will finish the landing.",
          ].join("\n")
        : [
            `Cake is landing this worktree into ${target} by replaying its commits on top of ${target}.`,
            "The rebase stopped on conflicts in these files:",
            "",
            listed,
            "",
            "Resolve each conflict in the working tree, preserving the intent of both sides.",
            "Stage the resolved files and continue the rebase with `GIT_EDITOR=true git rebase --continue` until the rebase is complete.",
            "",
            "Do not push, merge, or switch branches, and do not rewrite commit messages. Cake will finish the landing.",
          ].join("\n");
    await this.projectSessions.prompt(
      { sessionId, renderUserMessageAsMarkdown: false, attachments: [], text },
      { signal: this.signal },
    );
  }

  private async requestSquashMessage() {
    const sessionId = this.props.sessionId();
    if (!sessionId)
      throw new Error("Cake could not find the session to propose the commit message with");
    const target = this.status?.targetBranch ?? "its target";
    await this.projectSessions.prompt(
      {
        sessionId,
        renderUserMessageAsMarkdown: false,
        attachments: [],
        text: [
          `Cake is preparing to squash this worktree into ${target} as one commit.`,
          "",
          `Inspect the complete change (for example \`git log --reverse ${target}..HEAD\`, \`git diff --stat ${target}...HEAD\`, and file contents where needed), then propose one commit message describing the entire resulting change with the Cake \`worktrees.proposeSquashMessage\` tool: a concise subject line plus an optional body.`,
          "",
          "Do not modify Git state; Cake will create the commit.",
        ].join("\n"),
      },
      { signal: this.signal },
    );
  }

  private async finishLanded(workspacePath: string) {
    const currentStatus = this.status;
    const projectPath = currentStatus?.record.projectPath;
    const resolveAfterLanding = this.pendingResolveAfterLanding;
    this.phase = "idle";
    this.pendingStrategy = undefined;
    this.pendingAllowDirtyTarget = false;
    this.pendingResolveAfterLanding = false;
    this.stalled = false;
    if (currentStatus)
      this.status = {
        ...currentStatus,
        merged: true,
        record: { ...currentStatus.record, state: "landed", pendingStrategy: undefined },
      };
    if (currentStatus && projectPath && this.props.workspacePath() === workspacePath)
      await this.props.onLanded({
        ...currentStatus.record,
        state: "landed",
        pendingStrategy: undefined,
      });
    if (resolveAfterLanding && this.props.workspacePath() === workspacePath) await this.resolve();
  }

  private requiredWorkspacePath() {
    const workspacePath = this.props.workspacePath();
    if (!workspacePath) throw new Error("No project session is open");
    return workspacePath;
  }
}
