import { Store } from "r-state-tree";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

export interface SessionContinuationStoreProps {
  client: Pick<
    DesktopClient,
    "getWorktreeStatus" | "forkSession" | "forkWorktreeSession" | "handoffSession" | "loadSession"
  >;
  operations: SessionOperationCoordinatorStore;
  registry: SessionRegistryStore;
  sessionContext(): { sessionId: string; workspacePath: string } | undefined;
  closeCommandPane(): void;
  openSession(sessionId: string): Promise<void>;
  reportError(error: unknown): void;
}

/** Owns full-context forks and clean-context handoffs into replacement sessions. */
export class SessionContinuationStore extends Store<SessionContinuationStoreProps> {
  prompt: { sessionId: string; entryId: string; workspacePath: string } | undefined;
  private checkingWorktree = false;
  private activeOperationId: string | undefined;

  constructor(props: SessionContinuationStore["props"]) {
    super(props);
    this.effect(() => () => {
      if (this.activeOperationId) this.props.operations.finish(this.activeOperationId);
    });
  }

  /** Repeated fork requests are ignored while inspection, prompting, or dispatch is active. */
  async forkAt(entryId: string) {
    const context = this.props.sessionContext();
    if (
      !context ||
      this.signal.aborted ||
      this.checkingWorktree ||
      this.prompt ||
      this.activeOperationId
    )
      return;
    this.checkingWorktree = true;
    this.props.closeCommandPane();
    let status: Awaited<ReturnType<typeof this.props.client.getWorktreeStatus>>;
    try {
      try {
        status = await this.props.client.getWorktreeStatus({
          workspacePath: context.workspacePath,
        });
      } catch {
        status = undefined;
      }
      if (this.signal.aborted) return;
      if (!status) {
        await this.dispatchFork(context.sessionId, entryId);
        return;
      }
      this.prompt = { sessionId: context.sessionId, entryId, workspacePath: context.workspacePath };
    } finally {
      if (!this.signal.aborted) this.checkingWorktree = false;
    }
  }

  async handoffAt(entryId: string, prompt?: string, resolveSource = false) {
    const context = this.props.sessionContext();
    if (
      !context ||
      this.signal.aborted ||
      this.checkingWorktree ||
      this.prompt ||
      this.activeOperationId
    )
      return false;
    this.props.closeCommandPane();
    const operationId = this.props.operations.start("project-workbench");
    this.activeOperationId = operationId;
    try {
      await this.props.client.handoffSession({
        operationId,
        sessionId: context.sessionId,
        entryId,
        prompt: prompt?.trim() || undefined,
        resolveSource,
      });
      return true;
    } catch (error) {
      if (this.signal.aborted) return false;
      this.activeOperationId = undefined;
      this.props.operations.finish(operationId);
      this.props.reportError(error);
      return false;
    }
  }

  async resolvePrompt(choice: "existing" | "new-worktree" | "cancel") {
    const prompt = this.prompt;
    if (!prompt) return;
    this.prompt = undefined;
    if (choice === "cancel") return;
    if (choice === "existing") {
      await this.dispatchFork(prompt.sessionId, prompt.entryId);
      return;
    }
    const operationId = this.props.operations.start("project-workbench");
    try {
      const result = await this.props.client.forkWorktreeSession({
        operationId,
        sessionId: prompt.sessionId,
        entryId: prompt.entryId,
        workspacePath: prompt.workspacePath,
      });
      if (this.signal.aborted) return;
      const preview = await this.props.client.loadSession(result.sessionId);
      if (this.signal.aborted) return;
      if (preview) this.props.registry.hydratePreview(preview);
      await this.props.openSession(result.sessionId);
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
    } finally {
      this.props.operations.finish(operationId);
    }
  }

  acceptSnapshotOperation(operationId: string) {
    return operationId === this.activeOperationId;
  }

  reset() {
    if (this.activeOperationId) this.props.operations.finish(this.activeOperationId);
    this.activeOperationId = undefined;
    this.checkingWorktree = false;
    this.prompt = undefined;
  }

  receive(event: DesktopClientEvent) {
    if (
      (event.type !== "operation-completed" && event.type !== "operation-failed") ||
      !event.operationId ||
      event.operationId !== this.activeOperationId
    )
      return false;
    this.activeOperationId = undefined;
    this.props.operations.finish(event.operationId);
    if (event.type === "operation-failed") this.props.reportError(event.message);
    return true;
  }

  private async dispatchFork(sessionId: string, entryId: string) {
    const operationId = this.props.operations.start("project-workbench");
    this.activeOperationId = operationId;
    try {
      await this.props.client.forkSession({ operationId, sessionId, entryId });
    } catch (error) {
      if (this.signal.aborted) return;
      this.activeOperationId = undefined;
      this.props.operations.finish(operationId);
      this.props.reportError(error);
    }
  }
}
