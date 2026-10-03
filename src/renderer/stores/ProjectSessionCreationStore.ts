import { Store, child, createStore, effect as reactiveEffect } from "r-state-tree";
import type { ProjectSessionStartInput } from "../../domain/project-sessions/project-session-data";
import type { ChatConfiguration } from "../../ipc/session-contract";
import type { WorktreeRecord } from "../../domain/worktrees/managed-worktree-data";
import type { ComposerDeliveryInput } from "./ConversationComposerStore";
import { ClientContext } from "./context/ClientContext";
import type { ProjectPendingSessionsStore } from "./ProjectPendingSessionsStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import { WorktreeCreationStore, type WorktreeDraftChoice } from "./WorktreeCreationStore";

export interface CreatePromptedProjectSessionInput {
  workspacePath: string;
  name: string;
  initialPrompt: string;
  model?: ChatConfiguration;
  worktreeName?: string;
  markdown?: boolean;
}

export interface CreateDraftProjectSessionInput {
  workspacePath: string;
  name: string;
  initialPrompt: string;
  model?: ChatConfiguration;
}

export interface ProjectSessionCreationResult {
  workspacePath: string;
  sessionId: string;
  managedWorktree?: WorktreeRecord;
}

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

  /** Creates a cataloged renderer draft without acquiring a Pi runtime. */
  async createDraftSession(input: CreateDraftProjectSessionInput) {
    const sessionId = await this.createDraft(
      input.workspacePath,
      input.name,
      input.initialPrompt,
      input.model,
    );
    return { workspacePath: input.workspacePath, sessionId };
  }

  /**
   * Owns the managed-checkout-then-session-start sequence used by application controls.
   * A requested checkout must succeed before session creation; it never falls back to the Project
   * root. Main owns rollback of failed checkout creation, while this Store owns pending renderer
   * cleanup when session start fails.
   */
  async createPromptedSession(
    input: CreatePromptedProjectSessionInput,
  ): Promise<ProjectSessionCreationResult> {
    const managedWorktree = input.worktreeName
      ? await this.worktrees.create(input.workspacePath, {
          name: input.worktreeName,
          backgroundSetup: true,
        })
      : undefined;
    const workspacePath = managedWorktree?.worktreePath ?? input.workspacePath;
    const sessionId = await this.createPrompted(
      workspacePath,
      input.name,
      input.initialPrompt,
      input.model,
      input.markdown !== false,
    );
    return managedWorktree
      ? { workspacePath, sessionId, managedWorktree }
      : { workspacePath, sessionId };
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

  async activateSavedDraft(sessionId: string, choice?: WorktreeDraftChoice) {
    const saved = this.pending.savedRecord(sessionId);
    if (saved?.status !== "saved") return false;
    if (choice?.kind === "draft") return false;
    if (choice) this.configureDraftActivation(sessionId, choice);
    if (!(await this.prepare(sessionId, saved.text))) return false;
    const prepared = this.request(sessionId);
    if (!prepared) return false;
    const authority = this.pending.props.savedDrafts;
    if (!authority) throw new Error("Saved Draft authority is unavailable");
    const activated = await authority.activate(
      {
        sessionId,
        expectedRevision: saved.revision,
        workingDirectory: prepared.path,
      },
      { signal: this.signal },
    );
    this.pending.markActivated(activated.record);
    if (this.pending.isTemporary(sessionId))
      this.pending.materialize(sessionId, activated.workingDirectory);
    return true;
  }

  async start(sessionId: string, input: ComposerDeliveryInput) {
    if (this.pending.savedRecord(sessionId)?.status === "activating")
      throw new Error("This saved Draft is already starting; check the transcript before retrying");
    if (this.pending.isDraft(sessionId))
      throw new Error("Activate this saved Draft before sending a new message");
    const pending = this.request(sessionId);
    if (!pending) return false;
    this.pending.projectSubmission(sessionId, input.text);
    // This submission owns one transient request. Pi remains the durable title authority.
    // Start before checkout preparation, and never await naming on the prompt's critical path.
    const namingController = new AbortController();
    const namingSignal = AbortSignal.any([this.signal, namingController.signal]);
    const titleWork =
      !pending.name && input.text.trim() && !input.text.startsWith("/")
        ? Promise.resolve()
            .then(() =>
              this.client.workspaces.generateSessionTitle(input.text, { signal: namingSignal }),
            )
            .then((title) => {
              if (!title || namingSignal.aborted) return undefined;
              const conversation = this.pending.conversation(sessionId);
              if (conversation && !conversation.name) conversation.setFallbackTitle(title);
              return title;
            })
            // Main logs exhausted naming failures; they must not block the first prompt.
            .catch(() => undefined)
        : undefined;
    try {
      if (!(await this.prepare(sessionId, input.text))) {
        namingController.abort();
        this.pending.cancelSubmission(sessionId);
        return false;
      }
      const prepared = this.request(sessionId);
      if (!prepared) {
        namingController.abort();
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
        ...(titleWork ? { automaticTitle: false } : null),
        ...(input.presentationMode !== undefined
          ? { presentationMode: input.presentationMode }
          : null),
        ...(prepared.configuration !== undefined
          ? { configuration: prepared.configuration }
          : null),
        ...(prepared.name !== undefined ? { name: prepared.name } : null),
        ...(labelIds.length > 0 ? { labelIds } : null),
      };
      // Pi extension commands can complete without ever writing a transcript.
      // Attach the scoped observation first, rather than relying on the turn's
      // temporary lease to survive the start RPC / renderer promotion handoff.
      if (input.text.startsWith("/")) {
        this.props.registry.observationRetention.materialize(sessionId);
        if (!(await this.waitForRuntime(sessionId))) {
          namingController.abort();
          this.pending.cancelSubmission(sessionId);
          this.props.registry.observationRetention.remove(sessionId);
          return false;
        }
      }
      await this.client.projectSessions.start(startInput, { signal: this.signal });
      const latestName = this.pending.conversation(sessionId)?.name;
      this.pending.materialize(sessionId, prepared.path);
      void (async () => {
        // A manual name entered while start was in flight must reach Pi before the utility result.
        if (latestName && latestName !== startInput.name)
          await this.client.projectSessions.rename(
            { sessionId, name: latestName },
            { signal: namingSignal },
          );
        const title = await titleWork;
        if (!title || namingSignal.aborted || !this.props.registry.findSession(sessionId)) return;
        await this.client.projectSessions.rename(
          { sessionId, name: title, onlyIfUnnamed: true },
          { signal: namingSignal },
        );
      })().catch((error) => {
        if (!namingSignal.aborted) this.props.reportError(error);
      });
      return true;
    } catch (error) {
      namingController.abort();
      this.pending.cancelSubmission(sessionId);
      if (this.pending.isTemporary(sessionId))
        this.props.registry.observationRetention.remove(sessionId);
      throw error;
    }
  }

  private waitForRuntime(sessionId: string): Promise<boolean> {
    if (this.signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ready: boolean) => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener("abort", abort);
        dispose();
        resolve(ready);
      };
      const abort = () => finish(false);
      this.signal.addEventListener("abort", abort, { once: true });
      const dispose = reactiveEffect(() => {
        const session = this.props.registry.findSession(sessionId);
        if (!session || !this.pending.isTemporary(sessionId)) queueMicrotask(() => finish(false));
        else if (session.model.observedSnapshotRevision > 0) queueMicrotask(() => finish(true));
      });
    });
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
