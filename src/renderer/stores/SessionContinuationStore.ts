import { Store } from "r-state-tree";
import { suggestedWorktreeName } from "../../utils/worktree-name";
import { RendererClientContext } from "../client/RendererClientContext";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface SessionContinuationStoreProps {
  operations: SessionOperationCoordinatorStore;
  createWorktree(workspacePath: string, name: string): Promise<string>;
  sessionContext(): { sessionId: string; workspacePath: string } | undefined;
  sessionTitle(): string;
  closeCommandPane(): void;
  openSession(sessionId: string, workingDirectory: string): Promise<void>;
  reportError(error: unknown): void;
}

export interface ForkSessionPrompt {
  sessionId: string;
  entryId: string;
  workspacePath: string;
  destination: "existing" | "new-worktree";
  worktreeName: string;
  resolveParent: boolean;
}

/** Owns full-context forks and clean-context handoffs into replacement sessions. */
export class SessionContinuationStore extends Store<SessionContinuationStoreProps> {
  prompt: ForkSessionPrompt | undefined;
  private activeOperationId: string | undefined;

  get client() {
    return RendererClientContext.consume(this)!;
  }

  forkAt(entryId: string) {
    const context = this.props.sessionContext();
    if (!context || this.signal.aborted || this.prompt || this.activeOperationId) return;
    this.props.closeCommandPane();
    this.prompt = {
      ...context,
      entryId,
      destination: "existing",
      worktreeName: suggestedWorktreeName(this.props.sessionTitle()),
      resolveParent: false,
    };
  }

  selectDestination(destination: ForkSessionPrompt["destination"]) {
    if (this.prompt)
      this.prompt = {
        ...this.prompt,
        destination,
        resolveParent: destination === "new-worktree" && this.prompt.resolveParent,
      };
  }

  setWorktreeName(worktreeName: string) {
    if (this.prompt) this.prompt = { ...this.prompt, worktreeName };
  }

  setResolveParent(resolveParent: boolean) {
    if (this.prompt?.destination === "new-worktree")
      this.prompt = { ...this.prompt, resolveParent };
  }

  cancelPrompt() {
    this.prompt = undefined;
  }

  async confirmPrompt() {
    const prompt = this.prompt;
    if (!prompt) return;
    const worktreeName = prompt.worktreeName.trim();
    if (prompt.destination === "new-worktree" && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(worktreeName))
      return;
    this.prompt = undefined;
    let destinationWorkingDirectory: string | undefined;
    try {
      if (prompt.destination === "new-worktree")
        destinationWorkingDirectory = await this.props.createWorktree(
          prompt.workspacePath,
          worktreeName,
        );
      if (this.signal.aborted) return;
      await this.dispatchFork(
        prompt.sessionId,
        prompt.entryId,
        prompt.resolveParent,
        destinationWorkingDirectory,
      );
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
    }
  }

  async handoffAt(entryId: string, prompt?: string, resolveSource = false) {
    const context = this.props.sessionContext();
    if (!context) {
      this.props.reportError("There is no active session to hand off");
      return false;
    }
    if (this.signal.aborted || this.prompt || this.activeOperationId) return false;
    this.props.closeCommandPane();
    const operationId = this.props.operations.start("project-workbench");
    this.activeOperationId = operationId;
    try {
      const result = await this.client.projectSessions.handoff(
        {
          sessionId: context.sessionId,
          entryId,
          prompt: prompt?.trim() || undefined,
          resolveSource,
        },
        { signal: this.signal },
      );
      if (!this.signal.aborted)
        await this.props.openSession(result.sessionId, context.workspacePath);
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
      return false;
    } finally {
      this.clearActiveOperation();
    }
  }

  reset() {
    this.clearActiveOperation();
    this.prompt = undefined;
  }

  private clearActiveOperation() {
    if (this.activeOperationId) this.props.operations.finish(this.activeOperationId);
    this.activeOperationId = undefined;
  }

  private async dispatchFork(
    sessionId: string,
    entryId: string,
    resolveSource: boolean,
    destinationWorkingDirectory?: string,
  ) {
    const operationId = this.props.operations.start("project-workbench");
    this.activeOperationId = operationId;
    try {
      const input = {
        sessionId,
        entryId,
        resolveSource,
        destinationWorkingDirectory,
      };
      const result = await this.client.projectSessions.fork(input, { signal: this.signal });
      const workingDirectory =
        destinationWorkingDirectory ?? this.props.sessionContext()?.workspacePath;
      if (!this.signal.aborted && workingDirectory)
        await this.props.openSession(result.sessionId, workingDirectory);
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
    } finally {
      this.clearActiveOperation();
    }
  }
}
