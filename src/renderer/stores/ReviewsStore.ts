import { Store, child, createStore } from "r-state-tree";
import {
  hasSidecarConversation,
  type DiscussionAnchor,
} from "../../domain/discussion-sessions/discussion-session-data";
import type { Annotation, ModelPreset } from "../../ipc/session-contract";
import type { ReviewThread } from "../models/ReviewThread";
import type { Conversation } from "../models/Conversation";
import { ClientContext } from "./context/ClientContext";
import { ActiveProjectSessionContext } from "./context/ActiveProjectSessionContext";
import { describeError } from "../lib/error-details";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { ChatStore } from "./ChatStore";
import { DiscussionSessionStore } from "./DiscussionSessionStore";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { SessionRegistryStore } from "./SessionRegistryStore";
import { AnnotationDraftStore } from "./AnnotationDraftStore";

export interface ReviewsStoreProps {
  sessionRegistry: SessionRegistryStore;
  /** The live conversation Model for one Discussion sidecar (created on demand). */
  discussionSessionModel(sessionId: string, workingDirectory: string): Conversation;
  operations: SessionOperationCoordinatorStore;
  modelPresets(): readonly ModelPreset[];
  openModelPresetSettings(): void;
  settings?(): AppearanceSettingsStore | undefined;
}

/**
 * Discussion Session workflow across the loaded Project Sessions: drafting a
 * new thread, the per-thread conversation Stores, and thread resolution.
 */
export class ReviewsStore extends Store<ReviewsStoreProps> {
  activeThreadId: string | undefined;
  draftAnchor: DiscussionAnchor | undefined;
  draftFocusRequestRevision = 0;
  error: string | undefined;
  errorDetails: string | undefined;
  private readonly resolutionRevisions = new Map<string, number>();

  get client() {
    return ClientContext.consume(this)!;
  }

  get context() {
    return ActiveProjectSessionContext.consume(this);
  }

  private reportError(error: unknown) {
    const described = describeError(error);
    this.error = described.message;
    this.errorDetails = described.details;
  }

  get threads() {
    const context = this.context;
    return context ? this.threadsForSession(context.sessionId) : [];
  }

  threadsForSession(sessionId: string) {
    return this.props.sessionRegistry.findSession(sessionId)?.props.discussionCatalog.threads ?? [];
  }

  codeThreadsForSession(sessionId: string) {
    return this.threadsForSession(sessionId).filter((thread) => thread.anchor.view === "file");
  }

  get codeThreads() {
    return this.threads.filter((thread) => thread.anchor.view === "file");
  }
  get openThreads() {
    return this.codeThreads.filter((thread) => thread.status === "open");
  }
  get activeThread() {
    return this.threads.find((thread) => thread.id === this.activeThreadId) ?? this.openThreads[0];
  }
  /** The active parent's model picker; a new thread starts on the parent's model. */
  get configuration() {
    const context = this.context;
    return context ? this.configurationForSession(context.sessionId) : undefined;
  }
  private configurationForSession(sessionId: string) {
    return this.props.sessionRegistry.findSession(sessionId)?.conversationSessionStore
      .configurationStore;
  }
  private get liveThreads(): ReviewThread[] {
    return this.props.sessionRegistry.sessions.flatMap((session) =>
      session.props.discussionCatalog.threads.filter(hasSidecarConversation),
    );
  }
  private thread(threadId: string) {
    return this.props.sessionRegistry.sessions
      .flatMap((session) => session.props.discussionCatalog.threads)
      .find((thread) => thread.id === threadId);
  }

  /** One conversation Store per thread whose sidecar this window observes. */
  @child
  get discussionSessions(): DiscussionSessionStore[] {
    return this.liveThreads.map((thread) =>
      createStore(DiscussionSessionStore, {
        key: thread.id,
        thread,
        model: this.props.discussionSessionModel(thread.sidecarSessionId!, thread.workingDirectory),
        operations: this.props.operations,
        modelPresets: this.props.modelPresets,
        openModelPresetSettings: this.props.openModelPresetSettings,
        settings: this.props.settings,
        setResolved: (resolved) => this.resolveThread(thread.id, resolved),
      }),
    );
  }

  discussionSession(threadId: string) {
    return this.discussionSessions.find((session) => session.threadId === threadId);
  }

  chatStore(threadId: string) {
    return this.discussionSession(threadId)?.chatStore;
  }

  threadStreaming(threadId: string) {
    return this.discussionSession(threadId)?.streaming ?? false;
  }

  selectThread(threadId: string) {
    this.activeThreadId = threadId;
  }

  trySelectThread(threadId: string) {
    if (!this.threads.some((thread) => thread.id === threadId)) return false;
    this.selectThread(threadId);
    return true;
  }

  clearActiveThread() {
    this.activeThreadId = undefined;
  }

  prepareDraft(anchor: DiscussionAnchor) {
    this.draftChatStore.setDraft("");
    this.draftAnchor = anchor;
    this.draftFocusRequestRevision += 1;
  }

  cancelDraft() {
    this.draftAnchor = undefined;
    this.draftChatStore.setDraft("");
    this.annotationDraft.clear();
  }

  @child
  get annotationDraft(): AnnotationDraftStore {
    return createStore(AnnotationDraftStore, {
      onLimitReached: () =>
        this.reportError(new Error("A message can include at most 100 annotations")),
    });
  }

  /** Composer for a code-anchored thread that does not exist yet. */
  @child
  get draftChatStore(): ChatStore {
    return createStore(ChatStore, {
      id: () => "code-review-draft",
      parts: () =>
        this.draftAnchor
          ? [
              {
                id: `code-review-draft:${this.draftFocusRequestRevision}`,
                kind: "text" as const,
                role: "user" as const,
                text: this.draftAnchor.selectedText,
                status: "complete" as const,
              },
            ]
          : [],
      streaming: () => false,
      submitting: () => false,
      configuration: () => this.configuration,
      commands: () => [],
      placeholder: () => "Ask Cake about this code…",
      inputLabel: () => "Message code chat",
      focusRequestRevision: () => this.draftFocusRequestRevision,
      canSubmit: (draft) =>
        Boolean(this.draftAnchor && (draft.trim() || this.annotationDraft.annotations.length)),
      submit: async (draft) => {
        const anchor = this.draftAnchor;
        if (!anchor) return false;
        const threadId = await this.createThread(anchor, draft, this.annotationDraft.annotations);
        if (threadId && this.draftAnchor === anchor) {
          this.cancelDraft();
          this.selectThread(threadId);
        }
        return Boolean(threadId);
      },
      annotations: () => this.annotationDraft.annotations,
      addAnnotation: (annotation) => this.annotationDraft.add(annotation),
      updateAnnotation: (id, update) => this.annotationDraft.update(id, update),
      removeAnnotation: (id) => this.annotationDraft.remove(id),
      error: () => ({ message: this.error, details: this.errorDetails }),
    });
  }

  async createThread(
    anchor: DiscussionAnchor,
    body: string,
    annotations: readonly Annotation[] = [],
  ) {
    const context = this.context;
    if (!context) return undefined;
    return this.createThreadForSession(context, anchor, body, annotations);
  }

  async createSideChat(context: { sessionId: string; workingDirectory: string }, prompt: string) {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return undefined;
    return this.createThreadForSession(
      context,
      {
        path: `session:${context.sessionId}`,
        view: "session",
        start: { diffLine: 0 },
        end: { diffLine: 0 },
        selectedText: "",
        contextBefore: "",
        contextAfter: "",
        diff: "",
      },
      trimmedPrompt,
    );
  }

  /** Starts a thread on the parent's current model; it then moves on its own. */
  private async createThreadForSession(
    context: { sessionId: string; workingDirectory: string },
    anchor: DiscussionAnchor,
    body: string,
    annotations: readonly Annotation[] = [],
  ) {
    if (!body.trim() && annotations.length === 0) return undefined;
    this.clearError();
    const parent = this.props.sessionRegistry.findModel(context.sessionId);
    try {
      const accepted = await this.client.discussionSessions.start(
        {
          parentSessionId: context.sessionId,
          workingDirectory: context.workingDirectory,
          anchor,
          text: body.trim(),
          annotations: [...annotations],
          model: parent?.model
            ? { provider: parent.model.provider, id: parent.model.modelId }
            : undefined,
          thinkingLevel: parent?.model ? parent.thinkingLevel : undefined,
        },
        { signal: this.signal },
      );
      return this.signal.aborted ? undefined : accepted.thread.id;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return undefined;
    }
  }

  async resolveThread(threadId: string, resolved = true) {
    const thread = this.thread(threadId);
    const context = thread
      ? { sessionId: thread.parentSessionId, workingDirectory: thread.workingDirectory }
      : this.context;
    if (!context) return false;
    const revision = (this.resolutionRevisions.get(threadId) ?? 0) + 1;
    this.resolutionRevisions.set(threadId, revision);
    this.clearError();
    try {
      await this.client.discussionSessions.setResolved(
        {
          parentSessionId: context.sessionId,
          workingDirectory: context.workingDirectory,
          threadId,
          resolved,
        },
        { signal: this.signal },
      );
      return !this.signal.aborted && this.resolutionRevisions.get(threadId) === revision;
    } catch (error) {
      if (!this.signal.aborted && this.resolutionRevisions.get(threadId) === revision)
        this.reportError(error);
      return false;
    }
  }

  private clearError() {
    this.error = undefined;
    this.errorDetails = undefined;
  }
}
