import { Store } from "r-state-tree";
import { suggestedWorktreeName } from "../../utils/worktree-name";
import { ClientContext } from "./context/ClientContext";
import { SessionRegistryContext } from "./context/SessionRegistryContext";
import { describeError } from "../lib/error-details";
import { ProjectSessionCreationContext } from "./context/ProjectSessionCreationContext";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export type SessionContinuationDestination =
  | "existing"
  | "branch-worktree"
  | "project-root"
  | "new-worktree";

export interface SessionContinuationStoreProps {
  operations: SessionOperationCoordinatorStore;
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
  showPreview(sessionId: string): void;
  openSession(
    previewId: string,
    sessionId: string,
    workingDirectory: string,
    isCurrent: () => boolean,
  ): Promise<void>;
  returnToSource(sessionId: string): void;
  discardPreview(previewId: string, sourceSessionId: string): void;
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
  forkSetup:
    | {
        previewId: string;
        prompt: SessionContinuationPrompt;
        destinationWorkingDirectory?: string;
        sessionId?: string;
        error?: string;
      }
    | undefined;
  private setupRevision = 0;

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

  tryCancelPrompt() {
    if (!this.prompt) return false;
    this.cancelPrompt();
    return true;
  }

  async confirmPrompt() {
    const prompt = this.prompt;
    if (!prompt) return;
    const worktreeName = prompt.worktreeName.trim();
    const createsWorktree =
      prompt.destination === "branch-worktree" || prompt.destination === "new-worktree";
    if (createsWorktree && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(worktreeName)) return;
    const preview = SessionRegistryContext.consume(this)!.prepareForkPreview(
      prompt.sessionId,
      prompt.entryId,
      this.props.sessionTitle(),
    );
    this.prompt = undefined;
    this.forkSetup = { previewId: preview.sessionId, prompt };
    this.props.showPreview(preview.sessionId);
    await this.prepareFork();
  }

  retryFork() {
    if (!this.forkSetup?.error || this.activeOperationId) return;
    return this.prepareFork();
  }

  returnToSource() {
    const sourceSessionId = this.forkSetup?.prompt.sessionId;
    if (sourceSessionId) this.props.returnToSource(sourceSessionId);
  }

  discardPreview() {
    if (!this.forkSetup?.error || this.activeOperationId) return;
    this.props.discardPreview(this.forkSetup.previewId, this.forkSetup.prompt.sessionId);
    this.forkSetup = undefined;
  }

  private async prepareFork() {
    const setup = this.forkSetup;
    if (!setup) return;
    const revision = ++this.setupRevision;
    const current = () => !this.signal.aborted && revision === this.setupRevision;
    const prompt = setup.prompt;
    const worktreeName = prompt.worktreeName.trim();
    this.forkSetup = { ...setup, error: undefined };
    this.activeOperationId = this.props.operations.start("project-workbench");
    let destinationWorkingDirectory = setup.destinationWorkingDirectory;
    try {
      if (!destinationWorkingDirectory)
        switch (prompt.destination) {
          case "existing":
            destinationWorkingDirectory = prompt.workspacePath;
            break;
          case "project-root":
            destinationWorkingDirectory = prompt.projectPath;
            break;
          case "branch-worktree":
            destinationWorkingDirectory = await ProjectSessionCreationContext.consume(
              this,
            )!.createContinuationWorktree(prompt.projectPath, worktreeName, prompt.workspacePath);
            break;
          case "new-worktree":
            destinationWorkingDirectory = await ProjectSessionCreationContext.consume(
              this,
            )!.createContinuationWorktree(prompt.projectPath, worktreeName);
            break;
        }
      if (!current()) return;
      this.forkSetup = { ...this.forkSetup!, destinationWorkingDirectory };
      let sessionId = setup.sessionId;
      if (!sessionId) {
        const result = await this.client.projectSessions.fork(
          {
            sessionId: prompt.sessionId,
            workingDirectory: prompt.workspacePath,
            entryId: prompt.entryId,
            resolveSource: prompt.resolveParent,
            destinationWorkingDirectory,
          },
          { signal: this.signal },
        );
        if (!current()) return;
        sessionId = result.sessionId;
        this.forkSetup = { ...this.forkSetup!, sessionId };
      }
      await this.props.openSession(
        setup.previewId,
        sessionId,
        destinationWorkingDirectory!,
        current,
      );
      if (current()) this.forkSetup = undefined;
    } catch (error) {
      if (current()) this.forkSetup = { ...this.forkSetup!, error: describeError(error).message };
    } finally {
      if (revision === this.setupRevision) this.clearActiveOperation();
    }
  }

  reset() {
    this.setupRevision += 1;
    this.clearActiveOperation();
    this.prompt = undefined;
    if (this.forkSetup)
      this.forkSetup = {
        ...this.forkSetup,
        error: "Fork setup was interrupted. Backend changes may already exist.",
      };
  }

  private requestContinuation(entryId: string) {
    const context = this.props.sessionContext();
    if (!context) {
      this.props.reportError("There is no active session to fork");
      return false;
    }
    if (this.signal.aborted || this.prompt || this.activeOperationId || this.forkSetup)
      return false;
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
}
