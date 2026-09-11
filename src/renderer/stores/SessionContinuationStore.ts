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
  kind: "fork" | "handoff";
  sessionId: string;
  entryId: string;
  projectPath: string;
  workspacePath: string;
  canBranchFromCurrentWorktree: boolean;
  destination: SessionContinuationDestination;
  worktreeName: string;
  continuationPrompt?: string;
  resolveParent: boolean;
}

/** Owns full-context forks and clean-context handoffs into replacement sessions. */
export class SessionContinuationStore extends Store<SessionContinuationStoreProps> {
  prompt: SessionContinuationPrompt | undefined;
  private activeOperationId: string | undefined;

  get client() {
    return ClientContext.consume(this)!;
  }

  forkAt(entryId: string) {
    return this.requestContinuation("fork", entryId);
  }

  async handoffAt(entryId: string, prompt?: string, resolveSource = false) {
    return this.requestContinuation("handoff", entryId, prompt, resolveSource);
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

  private requestContinuation(
    kind: SessionContinuationPrompt["kind"],
    entryId: string,
    continuationPrompt?: string,
    resolveParent = false,
  ) {
    const context = this.props.sessionContext();
    if (!context) {
      this.props.reportError(
        `There is no active session to ${kind === "fork" ? "fork" : "hand off"}`,
      );
      return false;
    }
    if (this.signal.aborted || this.prompt || this.activeOperationId) return false;
    this.props.closeCommandPane();
    this.prompt = {
      ...context,
      kind,
      entryId,
      destination: "existing",
      worktreeName: suggestedWorktreeName(this.props.sessionTitle()),
      continuationPrompt: continuationPrompt?.trim() || undefined,
      resolveParent,
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
    const result =
      prompt.kind === "fork"
        ? await this.client.projectSessions.fork(target, { signal: this.signal })
        : await this.client.projectSessions.handoff(target, { signal: this.signal });
    if (this.signal.aborted) return;
    await this.props.openSession(result.sessionId, destinationWorkingDirectory);
    if (prompt.kind !== "handoff" || !prompt.continuationPrompt || this.signal.aborted) return;
    void this.client.projectSessions
      .prompt(
        {
          sessionId: result.sessionId,
          workingDirectory: destinationWorkingDirectory,
          text: prompt.continuationPrompt,
          attachments: [],
          renderUserMessageAsMarkdown: false,
        },
        { signal: this.signal },
      )
      .catch((error: unknown) => {
        if (!this.signal.aborted) this.props.reportError(error);
      });
  }
}
