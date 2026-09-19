import { type ComponentProps, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "../lib/utils";
import type { ChatTranscriptBehavior } from "./chat-message";
import type { ChatStore } from "../stores/ChatStore";
import type { EmbeddedEditorStore } from "../stores/EmbeddedEditorStore";
import type { ReviewsStore } from "../stores/ReviewsStore";
import type { SideChatStore } from "../stores/SideChatStore";
import { Button } from "./ui/button";
import { Chat } from "./chat";
import { EmbeddedEditorPane } from "./embedded-editor";
import { SideChatLayout } from "./side-chat-layout";
import { WorkspaceChatLayout } from "./workspace-chat-layout";

function anchorTitle(anchor: NonNullable<ReviewsStore["draftAnchor"]>) {
  const start = anchor.start.newLine ?? anchor.start.oldLine;
  const end = anchor.end.newLine ?? anchor.end.oldLine;
  if (!start) return anchor.path;
  return end && end !== start ? `${anchor.path} · L${start}–${end}` : `${anchor.path} · L${start}`;
}

export const IdeWorkspace = observer(function IdeWorkspace({
  editor,
  reviews,
  projectChat,
  sideChat,
  headerActions,
  conversationAccessory,
  projectComposerHeader,
  projectComposerContent,
  projectComposerLeadingAccessory,
  projectSidebar,
  projectSidebarVisible,
  projectSidebarWidth,
  onProjectSidebarWidthChange,
  sessionTitle,
  terminalDock,
  transcriptBehavior,
}: {
  editor: EmbeddedEditorStore;
  reviews: ReviewsStore;
  projectChat: ChatStore;
  sideChat: SideChatStore;
  /** Session-scoped controls shown in the chat sidebar header, such as the side chats menu. */
  headerActions?: ReactNode;
  conversationAccessory?(children: ReactNode): ReactNode;
  projectComposerHeader?: ReactNode;
  projectComposerContent?: ReactNode;
  projectComposerLeadingAccessory?: ComponentProps<typeof Chat>["composerLeadingAccessory"];
  projectSidebar: ReactNode;
  projectSidebarVisible: boolean;
  projectSidebarWidth: number;
  onProjectSidebarWidthChange(width: number): void;
  sessionTitle: string;
  terminalDock?: ReactNode;
  transcriptBehavior: ChatTranscriptBehavior;
}) {
  const draftAnchor = reviews.draftAnchor;
  const activeThread = reviews.activeThreadId
    ? reviews.threads.find(
        (thread) => thread.id === reviews.activeThreadId && thread.anchor.view === "file",
      )
    : undefined;
  const contextualAnchor = draftAnchor ?? activeThread?.anchor;
  const contextualChat = draftAnchor
    ? reviews.draftChatStore
    : activeThread
      ? reviews.chatStore(activeThread.id)
      : undefined;
  const chat = contextualChat ?? projectChat;
  const closeContext = () => {
    if (draftAnchor) reviews.cancelDraft();
    reviews.clearActiveThread();
  };
  const sideChatTranscriptBehavior =
    transcriptBehavior.openSourceLocation || transcriptBehavior.workspacePath
      ? {
          openSourceLocation: transcriptBehavior.openSourceLocation,
          workspacePath: transcriptBehavior.workspacePath,
        }
      : undefined;

  const conversation = (
    <SideChatLayout
      store={sideChat}
      renderChat={(sideChatStore) => (
        <Chat
          store={sideChatStore}
          embedded
          compact
          transcriptBehavior={sideChatTranscriptBehavior}
        />
      )}
    >
      <Chat
        className="h-full"
        store={chat}
        transcriptBehavior={transcriptBehavior}
        composerHeader={contextualChat ? undefined : projectComposerHeader}
        composerContent={contextualChat ? undefined : projectComposerContent}
        composerLeadingAccessory={projectComposerLeadingAccessory}
      />
    </SideChatLayout>
  );

  return (
    <WorkspaceChatLayout
      workspace={<EmbeddedEditorPane store={editor} />}
      workspaceLabel="VS Code workspace"
      chatSidebarVisible={editor.chatSidebarVisible}
      chatSidebarWidth={editor.chatSidebarWidth}
      onChatSidebarWidthChange={(width) => editor.setChatSidebarWidth(width)}
      projectSidebar={projectSidebar}
      projectSidebarVisible={projectSidebarVisible}
      projectSidebarWidth={projectSidebarWidth}
      onProjectSidebarWidthChange={onProjectSidebarWidthChange}
      terminalDock={terminalDock}
      chatSidebar={
        <>
          <header
            className={cn(
              "flex select-none items-center justify-between gap-3 border-b border-border px-3 [-webkit-app-region:drag]",
              contextualAnchor ? "h-14" : "h-[35px]",
            )}
          >
            <div className="min-w-0">
              <strong className="block truncate text-xs">
                {contextualAnchor ? "Chat about selection" : sessionTitle}
              </strong>
              {contextualAnchor ? (
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {anchorTitle(contextualAnchor)}
                </span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
              {headerActions}
              {contextualAnchor ? (
                <Button variant="ghost" size="sm" onClick={closeContext}>
                  Project chat
                </Button>
              ) : null}
            </div>
          </header>
          <div className="min-h-0 flex-1">
            {conversationAccessory ? conversationAccessory(conversation) : conversation}
          </div>
        </>
      }
    />
  );
});
