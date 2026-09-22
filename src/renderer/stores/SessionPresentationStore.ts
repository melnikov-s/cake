import { Store, child, createStore } from "r-state-tree";
import { workingDirectoryEditorLocation, type EditorLocation } from "../../ipc/editor-location";
import {
  discussionAnchorFromEditorSelection,
  sourceAttachmentFromEditorSelection,
} from "../../utils/editor-selection";
import { reviewThreadAnnotations } from "../../utils/review-thread-annotations";
import type { StoreEvent } from "../events/StoreEvent";
import { BrowserStore } from "./BrowserStore";
import { EmbeddedEditorStore } from "./EmbeddedEditorStore";
import type { ProjectSessionStore } from "./ProjectSessionStore";
import type { ReviewsStore } from "./ReviewsStore";

export interface SessionPresentationStoreProps {
  activeSession(): ProjectSessionStore | undefined;
  activeSessionId(): string | undefined;
  activeSessionResolved(): boolean;
  projectPath(): string | undefined;
  reviews(): ReviewsStore;
  dismissCommandPane(): void;
  startCakeChat(prompt?: string): Promise<void>;
  toggleProjectSidebar(): void;
  enterProjectSidebarMode(): void;
  leaveProjectSidebarMode(): void;
  projectSidebarWidth(): number;
}

/** Coordinates Agent, embedded VS Code, browser, and Draw presentation for the active session. */
export class SessionPresentationStore extends Store<SessionPresentationStoreProps> {
  private get session() {
    return this.props.activeSession();
  }
  private get reviews() {
    return this.props.reviews();
  }

  @child
  get embeddedEditorStore(): EmbeddedEditorStore {
    return createStore(EmbeddedEditorStore, {
      projectPath: this.props.projectPath,
      presentationMode: () => this.session?.presentationMode ?? "normal",
      setPresentationMode: (mode) => this.session?.showPresentation(mode),
      chatSidebarVisible: () => this.session?.workspaceChatSidebarVisible ?? true,
      toggleChatSidebar: () => this.session?.toggleWorkspaceChatSidebar(),
      showChatSidebar: () => this.session?.showWorkspaceChatSidebar(),
      chatSidebarWidth: () => this.session?.workspaceChatSidebarWidth ?? 420,
      setChatSidebarWidth: (width) => this.session?.setWorkspaceChatSidebarWidth(width),
      annotations: () => {
        const sessionId = this.props.activeSessionId();
        if (!sessionId) return undefined;
        return reviewThreadAnnotations(
          sessionId,
          this.reviews.codeThreadsForSession(sessionId),
          (threadId) => this.reviews.threadStreaming(threadId),
        );
      },
      startCakeChat: this.props.startCakeChat,
      enterProjectSidebarMode: this.props.enterProjectSidebarMode,
      leaveProjectSidebarMode: this.props.leaveProjectSidebarMode,
      projectSidebarWidth: this.props.projectSidebarWidth,
    });
  }

  @child
  get browserStore(): BrowserStore {
    return createStore(BrowserStore, {
      sessionId: this.props.activeSessionId,
      presentationMode: () => this.session?.presentationMode ?? "normal",
      setPresentationMode: (mode) => this.session?.showPresentation(mode),
      chatSidebarVisible: () => this.session?.workspaceChatSidebarVisible ?? true,
      chatSidebarWidth: () => this.session?.workspaceChatSidebarWidth ?? 420,
      setChatSidebarWidth: (width) => this.session?.setWorkspaceChatSidebarWidth(width),
      appendAttachment: (attachment) =>
        this.session?.conversationSessionStore.composerStore.draftStore.appendAttachments([
          attachment,
        ]),
      enterProjectSidebarMode: this.props.enterProjectSidebarMode,
      leaveProjectSidebarMode: this.props.leaveProjectSidebarMode,
    });
  }

  suspend() {
    this.session?.conversationSessionStore.composerStore.draftStore.setEditorContextAttachment(
      undefined,
    );
    if (this.session?.presentationMode === "draw")
      void this.session.drawStore.flush().catch(() => undefined);
    this.embeddedEditorStore.suspend();
    this.browserStore.suspend();
  }

  private async flushDrawBeforeLeaving() {
    if (this.session?.presentationMode !== "draw") return true;
    try {
      await this.session.drawStore.flush();
      return true;
    } catch {
      return false;
    }
  }

  async backToAgent() {
    const session = this.session;
    if (!(await this.flushDrawBeforeLeaving())) return;
    session?.conversationSessionStore.composerStore.draftStore.setEditorContextAttachment(
      undefined,
    );
    this.embeddedEditorStore.suspend();
    this.browserStore.suspend();
    session?.showPresentation("normal");
    session?.conversationSessionStore.composerStore.draftStore.requestFocus();
  }

  restore() {
    if (this.props.activeSessionResolved() || !this.session) return;
    if (this.session.presentationMode === "vscode")
      void this.embeddedEditorStore.restore(this.session.takePendingEditorLocation());
    else if (this.session.presentationMode === "draw") void this.session.drawStore.initialize();
    else if (this.session.presentationMode === "browser") void this.browserStore.restore();
  }

  async openWorkspaceChanges() {
    if (!this.canOpen() || !(await this.flushDrawBeforeLeaving())) return;
    this.props.dismissCommandPane();
    this.reviews.clearActiveThread();
    await this.embeddedEditorStore.showSourceControl();
  }

  async openReviewThread(threadId: string) {
    if (!this.canOpen()) return;
    const thread = this.reviews.threads.find((item) => item.id === threadId);
    if (!thread || thread.anchor.view !== "file") return;
    this.reviews.selectThread(thread.id);
    await this.openFile(
      workingDirectoryEditorLocation({
        path: thread.anchor.path,
        range: {
          start: {
            line:
              (thread.anchor.start.newLine ??
                thread.anchor.start.oldLine ??
                thread.anchor.start.diffLine + 1) - 1,
            column: thread.anchor.start.column,
          },
          end: {
            line:
              (thread.anchor.end.newLine ??
                thread.anchor.end.oldLine ??
                thread.anchor.end.diffLine + 1) - 1,
            column: thread.anchor.end.column,
          },
        },
      }),
    );
  }

  async openIde() {
    if (!this.canOpen() || !(await this.flushDrawBeforeLeaving())) return;
    this.props.dismissCommandPane();
    this.reviews.clearActiveThread();
    this.browserStore.suspend();
    await this.embeddedEditorStore.show();
  }

  async openBrowser() {
    if (!this.canOpen() || !(await this.flushDrawBeforeLeaving())) return;
    this.props.dismissCommandPane();
    this.reviews.clearActiveThread();
    this.embeddedEditorStore.suspend();
    await this.browserStore.show();
  }

  async openDraw() {
    if (!this.canOpen()) return;
    this.props.dismissCommandPane();
    this.reviews.clearActiveThread();
    this.embeddedEditorStore.suspend();
    this.browserStore.suspend();
    this.session!.showPresentation("draw");
    await this.session!.drawStore.initialize();
  }

  async toggleIde() {
    if (this.embeddedEditorStore.visible) await this.backToAgent();
    else await this.openIde();
  }

  async openFile(location: EditorLocation) {
    if (!this.canOpen() || !(await this.flushDrawBeforeLeaving())) return;
    this.props.dismissCommandPane();
    this.browserStore.suspend();
    await this.embeddedEditorStore.show(location);
  }

  private canOpen() {
    return !this.props.activeSessionResolved() && Boolean(this.session && this.props.projectPath());
  }

  receive(event: StoreEvent) {
    if (event.type === "browser-state-changed" || event.type === "browser-element-selected")
      this.browserStore.receive(event);
    if (
      event.type === "embedded-editor-selection" ||
      event.type === "embedded-editor-selection-cleared"
    ) {
      this.embeddedEditorStore.receive(event);
      if (event.workspacePath === this.props.projectPath())
        this.session?.conversationSessionStore.composerStore.draftStore.setEditorContextAttachment(
          this.embeddedEditorStore.visible
            ? this.embeddedEditorStore.activeContextAttachment
            : undefined,
        );
      return;
    }
    if (event.type === "embedded-editor-back-to-agent") {
      if (event.workspacePath === this.props.projectPath()) void this.backToAgent();
      return;
    }
    if (event.type === "embedded-editor-annotation-opened") {
      if (
        event.workspacePath === this.props.projectPath() &&
        event.sessionId === this.props.activeSessionId() &&
        this.reviews.trySelectThread(event.threadId)
      ) {
        this.reviews.cancelDraft();
        this.embeddedEditorStore.showChatSidebar();
      }
      return;
    }
    if (event.type === "embedded-editor-toggle-chat") {
      if (event.workspacePath === this.props.projectPath())
        this.embeddedEditorStore.toggleChatSidebar();
      return;
    }
    if (event.type === "embedded-editor-toggle-sidebar") {
      if (event.workspacePath === this.props.projectPath()) this.props.toggleProjectSidebar();
      return;
    }
    if (event.type === "embedded-editor-entered") {
      if (event.workspacePath === this.props.projectPath())
        this.embeddedEditorStore.showAgentEditor();
      return;
    }
    if (event.type === "browser-entered") {
      if (
        event.workspacePath === this.props.projectPath() &&
        event.sessionId === this.props.activeSessionId()
      ) {
        this.embeddedEditorStore.suspend();
        this.browserStore.showAgentBrowser();
      }
      return;
    }
    if (event.type === "embedded-editor-side-chat-requested") {
      if (event.workspacePath !== this.props.projectPath() || !this.session) return;
      this.reviews.clearActiveThread();
      this.reviews.prepareDraft(discussionAnchorFromEditorSelection(event));
      this.embeddedEditorStore.showChatSidebar();
      return;
    }
    if (event.type === "embedded-editor-annotation-requested") {
      if (event.workspacePath !== this.props.projectPath() || !this.session) return;
      this.reviews.cancelDraft();
      this.reviews.clearActiveThread();
      this.session.conversationSessionStore.composerStore.draftStore.addSourceAttachment(
        sourceAttachmentFromEditorSelection(event, event.comment),
      );
      this.embeddedEditorStore.showChatSidebar();
    }
  }
}
