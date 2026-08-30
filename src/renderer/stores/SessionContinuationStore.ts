import { Store } from "r-state-tree";
import { suggestedWorktreeName } from "../../utils/worktree-name";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

const HANDOFF_TIMEOUT_MS = 30_000;

export interface SessionContinuationStoreProps {
  client: Pick<
    DesktopClient,
    "forkSession" | "forkSessionToWorkspace" | "handoffSession" | "loadSession"
  >;
  operations: SessionOperationCoordinatorStore;
  registry: SessionRegistryStore;
  createWorktree(workspacePath: string, name: string): Promise<string>;
  sessionContext(): { sessionId: string; workspacePath: string } | undefined;
  sessionTitle(): string;
  closeCommandPane(): void;
  openSession(sessionId: string): Promise<void>;
  reportError(error: unknown): void;
  handoffTimeoutMs?: number;
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
  private handoffTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor(props: SessionContinuationStore["props"]) {
    super(props);
    this.effect(() => () => this.clearActiveOperation());
  }

  /** Repeated fork requests are ignored while prompting or dispatch is active. */
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
    if (prompt.destination === "existing") {
      await this.dispatchFork(prompt.sessionId, prompt.entryId, prompt.resolveParent);
      return;
    }
    let operationId: string | undefined;
    try {
      const destinationWorkspacePath = await this.props.createWorktree(
        prompt.workspacePath,
        worktreeName,
      );
      if (this.signal.aborted) return;
      operationId = this.props.operations.start("project-workbench");
      const result = await this.props.client.forkSessionToWorkspace({
        operationId,
        sessionId: prompt.sessionId,
        entryId: prompt.entryId,
        sourceWorkspacePath: prompt.workspacePath,
        destinationWorkspacePath,
        resolveSource: prompt.resolveParent,
      });
      if (this.signal.aborted) return;
      const preview = await this.props.client.loadSession(result.sessionId);
      if (this.signal.aborted) return;
      if (preview) this.props.registry.hydratePreview(preview);
      await this.props.openSession(result.sessionId);
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
    } finally {
      if (operationId) this.props.operations.finish(operationId);
    }
  }

  async handoffAt(entryId: string, prompt?: string, resolveSource = false) {
    const context = this.props.sessionContext();
    if (this.signal.aborted) return false;
    if (!context) {
      this.props.reportError("There is no active session to hand off");
      return false;
    }
    if (this.prompt) {
      this.props.reportError("Cancel or finish the open fork before handing off this session");
      return false;
    }
    if (this.activeOperationId) {
      this.props.reportError("A session fork or handoff is already in progress");
      return false;
    }
    this.props.closeCommandPane();
    const operationId = this.props.operations.start("project-workbench");
    this.activeOperationId = operationId;
    this.handoffTimeout = setTimeout(() => {
      if (this.activeOperationId !== operationId) return;
      this.clearActiveOperation();
      this.props.reportError("Session handoff timed out. Please try again");
    }, this.props.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS);
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
      if (this.signal.aborted || this.activeOperationId !== operationId) return false;
      this.clearActiveOperation();
      this.props.reportError(error);
      return false;
    }
  }

  acceptSnapshotOperation(operationId: string) {
    return operationId === this.activeOperationId;
  }

  reset() {
    this.clearActiveOperation();
    this.prompt = undefined;
  }

  receive(event: DesktopClientEvent) {
    if (
      (event.type !== "operation-completed" && event.type !== "operation-failed") ||
      !event.operationId ||
      event.operationId !== this.activeOperationId
    )
      return false;
    this.clearActiveOperation();
    if (event.type === "operation-failed") this.props.reportError(event.message);
    return true;
  }

  private clearActiveOperation() {
    if (this.handoffTimeout) clearTimeout(this.handoffTimeout);
    this.handoffTimeout = undefined;
    if (this.activeOperationId) this.props.operations.finish(this.activeOperationId);
    this.activeOperationId = undefined;
  }

  private async dispatchFork(sessionId: string, entryId: string, resolveSource: boolean) {
    const operationId = this.props.operations.start("project-workbench");
    this.activeOperationId = operationId;
    try {
      await this.props.client.forkSession({ operationId, sessionId, entryId, resolveSource });
    } catch (error) {
      if (this.signal.aborted) return;
      this.activeOperationId = undefined;
      this.props.operations.finish(operationId);
      this.props.reportError(error);
    }
  }
}
