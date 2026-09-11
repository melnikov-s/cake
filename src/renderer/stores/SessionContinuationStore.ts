import { Store } from "r-state-tree";
import { suggestedWorktreeName } from "../../utils/worktree-name";
import { ClientContext } from "./context/ClientContext";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export type SessionContinuationDestination =
  | "existing"
  | "branch-worktree"
  | "project-root"
  | "new-worktree";

export interface SessionContinuationStoreProps {
  operations: SessionOperationCoordinatorStore;
  createWorktree(projectPath: string, name: string, baseWorktreePath?: string): Promise<string>;
  sessionContext():
    | {
        sessionId: string;
        projectPath: string;
        workspacePath: string;
        canBranchFromCurrentWorktree: boolean;
      }
    | undefined;
  sessionTitle(): string;
  closeCommandPane(): void;
  openSession(sessionId: string, workingDirectory: string): Promise<void>;
  reportError(error: unknown): void;
}

export interface SessionContinuationPrompt {
  sessionId: string;
  entryId: string;
  projectPath: string;
  workspacePath: string;
  canBranchFromCurrentWorktree: boolean;
  destination: SessionContinuationDestination;
  worktreeName: string;
  resolveParent: boolean;
}

/** Owns detached full-context forks and in-place tool compaction. */
export class SessionContinuationStore extends Store<SessionContinuationStoreProps> {
  prompt: SessionContinuationPrompt | undefined;
  private activeOperationId: string | undefined;

  get client() {
    return ClientContext.consume(this)!;
  }

  forkAt(entryId: string) {
    return this.requestContinuation(entryId);
  }

  async toolCompactAt(entryId: string, prompt?: string) {
    const context = this.props.sessionContext();
    if (!context) {
      this.props.reportError("There is no active session to compact");
      return false;
    }
    if (this.signal.aborted || this.prompt || this.activeOperationId) return false;
    this.props.closeCommandPane();
    this.activeOperationId = this.props.operations.start("project-workbench");
    try {
      await this.client.projectSessions.toolCompact(
        {
          sessionId: context.sessionId,
          workingDirectory: context.workspacePath,
          entryId,
          prompt: prompt?.trim() || undefined,
        },
        { signal: this.signal },
      );
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
      return false;
    } finally {
      this.clearActiveOperation();
    }
  }

  selectDestination(destination: SessionContinuationDestination) {
    if (!this.prompt) return;
    if (destination === "branch-worktree" && !this.prompt.canBranchFromCurrentWorktree) return;
    this.prompt = { ...this.prompt, destination };
  }

  setWorktreeName(worktreeName: string) {
    if (this.prompt) this.prompt = { ...this.prompt, worktreeName };
  }

  setResolveParent(resolveParent: boolean) {
    if (this.prompt) this.prompt = { ...this.prompt, resolveParent };
  }

  cancelPrompt() {
    this.prompt = undefined;
  }

  async confirmPrompt() {
    const prompt = this.prompt;
    if (!prompt) return;
    const worktreeName = prompt.worktreeName.trim();
    const createsWorktree =
      prompt.destination === "branch-worktree" || prompt.destination === "new-worktree";
    if (createsWorktree && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(worktreeName)) return;
    this.prompt = undefined;
    this.activeOperationId = this.props.operations.start("project-workbench");
    let destinationWorkingDirectory: string | undefined;
    try {
      switch (prompt.destination) {
        case "existing":
          destinationWorkingDirectory = prompt.workspacePath;
          break;
        case "project-root":
          destinationWorkingDirectory = prompt.projectPath;
          break;
        case "branch-worktree":
          destinationWorkingDirectory = await this.props.createWorktree(
            prompt.projectPath,
            worktreeName,
            prompt.workspacePath,
          );
          break;
        case "new-worktree":
          destinationWorkingDirectory = await this.props.createWorktree(
            prompt.projectPath,
            worktreeName,
          );
          break;
      }
      if (this.signal.aborted) return;
      await this.dispatchContinuation(prompt, destinationWorkingDirectory);
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
    } finally {
      this.clearActiveOperation();
    }
  }

  reset() {
    this.clearActiveOperation();
    this.prompt = undefined;
  }

  private requestContinuation(entryId: string) {
    const context = this.props.sessionContext();
    if (!context) {
      this.props.reportError("There is no active session to fork");
      return false;
    }
    if (this.signal.aborted || this.prompt || this.activeOperationId) return false;
    this.props.closeCommandPane();
    this.prompt = {
      ...context,
      entryId,
      destination: "existing",
      worktreeName: suggestedWorktreeName(this.props.sessionTitle()),
      resolveParent: false,
    };
    return true;
  }

  private clearActiveOperation() {
    if (this.activeOperationId) this.props.operations.finish(this.activeOperationId);
    this.activeOperationId = undefined;
  }

  private async dispatchContinuation(
    prompt: SessionContinuationPrompt,
    destinationWorkingDirectory: string,
  ) {
    const target = {
      sessionId: prompt.sessionId,
      workingDirectory: prompt.workspacePath,
      entryId: prompt.entryId,
      resolveSource: prompt.resolveParent,
      destinationWorkingDirectory,
    };
    const result = await this.client.projectSessions.fork(target, { signal: this.signal });
    if (this.signal.aborted) return;
    await this.props.openSession(result.sessionId, destinationWorkingDirectory);
  }
}
