import { Store, child, createStore } from "r-state-tree";
import type { ProjectSessionStartInput } from "../../domain/project-sessions/project-session-data";
import type { ChatConfiguration } from "../../ipc/session-contract";
import type { ComposerDeliveryInput } from "./ConversationComposerStore";
import { ClientContext } from "./context/ClientContext";
import type { ProjectPendingSessionsStore } from "./ProjectPendingSessionsStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import { WorktreeCreationStore, type WorktreeDraftChoice } from "./WorktreeCreationStore";

export interface ProjectSessionCreationStoreProps {
  registry: SessionRegistryStore;
  operations: SessionOperationCoordinatorStore;
  catalog: SessionCatalogStore;
  activeSessionId(): string | undefined;
  defaultConfiguration?(): ChatConfiguration | undefined;
  activateWorkspace(path: string): void;
  reportError(error: unknown): void;
}

/** Owns staged activation and background Project Session creation policy. */
export class ProjectSessionCreationStore extends Store<ProjectSessionCreationStoreProps> {
  private get client() {
    return ClientContext.consume(this)!;
  }

  private get pending(): ProjectPendingSessionsStore {
    return this.props.registry.pendingSessions;
  }

  @child
  get worktrees(): WorktreeCreationStore {
    return createStore(WorktreeCreationStore, {
      operations: this.props.operations,
      catalog: this.props.catalog,
      relocateTemporarySession: (sessionId, workspacePath) => {
        this.pending.relocate(sessionId, workspacePath);
        if (this.props.activeSessionId() === sessionId) this.props.activateWorkspace(workspacePath);
      },
      reportError: this.props.reportError,
    });
  }

  async createDraft(
    path: string,
    name: string,
    initialPrompt: string,
    configuration?: ChatConfiguration,
  ) {
    const sessionId = crypto.randomUUID();
    this.pending.prepare(path, sessionId);
    const conversation = this.pending.conversation(sessionId)!;
    conversation.setName(name);
    if (configuration) conversation.setConfiguration(configuration);
    try {
      await this.pending.createDraft(sessionId, initialPrompt, []);
      return sessionId;
    } catch (error) {
      this.props.registry.removeSession(sessionId);
      throw error;
    }
  }

  async createPrompted(
    path: string,
    name: string,
    initialPrompt: string,
    configuration?: ChatConfiguration,
    renderUserMessageAsMarkdown = true,
  ) {
    const sessionId = crypto.randomUUID();
    this.pending.prepare(path, sessionId);
    const conversation = this.pending.conversation(sessionId)!;
    conversation.setName(name);
    if (configuration) conversation.setConfiguration(configuration);
    const input: ProjectSessionStartInput = {
      sessionId,
      workingDirectory: path,
      text: initialPrompt,
      renderUserMessageAsMarkdown,
      attachments: [],
      name,
      ...(configuration ? { configuration } : null),
    };
    this.pending.projectSubmission(sessionId, name);
    try {
      await this.client.projectSessions.start(input, { signal: this.signal });
      this.pending.materialize(sessionId, path);
      return sessionId;
    } catch (error) {
      this.props.registry.removeSession(sessionId);
      throw error;
    }
  }

  configureDraftActivation(sessionId: string, choice: WorktreeDraftChoice) {
    this.worktrees.select(sessionId, choice);
  }

  choice(sessionId: string) {
    return this.worktrees.choice(sessionId);
  }

  candidates(sessionId: string) {
    const session = this.props.registry.findSession(sessionId);
    if (!session) return [];
    const projectPath =
      this.props.catalog.projectOfManagedWorktree(session.workspacePath) ?? session.workspacePath;
    return this.worktrees.candidates(projectPath);
  }

  private async prepare(sessionId: string, firstUserMessage: string) {
    const session = this.props.registry.findSession(sessionId);
    if (!session || !this.pending.isTemporary(sessionId)) return true;
    const projectPath =
      this.props.catalog.projectOfManagedWorktree(session.workspacePath) ?? session.workspacePath;
    return this.worktrees.prepare(
      sessionId,
      projectPath,
      firstUserMessage,
      this.pending.conversation(sessionId)?.name,
    );
  }

  async start(sessionId: string, input: ComposerDeliveryInput) {
    const pending = this.request(sessionId);
    if (!pending) return false;
    this.pending.projectSubmission(sessionId, input.text);
    try {
      if (!(await this.prepare(sessionId, input.text))) {
        this.pending.cancelSubmission(sessionId);
        return false;
      }
      const prepared = this.request(sessionId);
      if (!prepared) {
        this.pending.cancelSubmission(sessionId);
        return false;
      }
      const labelIds = this.pending.conversation(sessionId)?.labelIds ?? [];
      const startInput: ProjectSessionStartInput = {
        sessionId,
        workingDirectory: prepared.path,
        text: input.text,
        renderUserMessageAsMarkdown: input.renderUserMessageAsMarkdown,
        attachments: input.attachments,
        ...(input.presentationMode !== undefined
          ? { presentationMode: input.presentationMode }
          : null),
        ...(prepared.configuration !== undefined
          ? { configuration: prepared.configuration }
          : null),
        ...(prepared.name !== undefined ? { name: prepared.name } : null),
        ...(labelIds.length > 0 ? { labelIds } : null),
      };
      await this.client.projectSessions.start(startInput, { signal: this.signal });
      this.pending.materialize(sessionId, prepared.path);
      return true;
    } catch (error) {
      this.pending.cancelSubmission(sessionId);
      throw error;
    }
  }

  request(sessionId: string) {
    const session = this.props.registry.findSession(sessionId);
    if (!session || !this.pending.isTemporary(sessionId)) return undefined;
    return {
      path: session.workspacePath,
      configuration:
        this.pending.conversation(sessionId)?.configuration ?? this.props.defaultConfiguration?.(),
      name: this.pending.conversation(sessionId)?.name,
    };
  }
}
