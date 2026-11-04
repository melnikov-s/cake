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
import { EditorSelectionPills } from "./editor-selection-pills";
import type { EditorSelectionsStore } from "../stores/EditorSelectionsStore";
import { EmbeddedEditorPane } from "./embedded-editor";
import { SideChatLayout } from "./side-chat-layout";
import { NestedChat } from "./nested-chat";
import { WorkspaceChatLayout } from "./workspace-chat-layout";

function anchorTitle(anchor: NonNullable<ReviewsStore["draftAnchor"]>) {
  const start = anchor.start.newLine ?? anchor.start.oldLine;
  const end = anchor.end.newLine ?? anchor.end.oldLine;
  if (!start) return anchor.path;
  return end && end !== start ? `${anchor.path} · L${start}–${end}` : `${anchor.path} · L${start}`;
}

export const IdeWorkspace = observer(function IdeWorkspace({
  editor,
  selections,
  reviews,
  projectChat,
  sideChat,
  headerLeading,
  headerActions,
  conversationHeader,
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
  selections: EditorSelectionsStore;
  reviews: ReviewsStore;
  projectChat: ChatStore;
  sideChat: SideChatStore;
  headerLeading?: ReactNode;
  /** Session-scoped controls shown in the chat sidebar header, such as the side chats menu. */
  headerActions?: ReactNode;
  conversationHeader?: ReactNode;
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
  const closeContext = () => {
    if (draftAnchor) reviews.cancelDraft();
    reviews.clearActiveThread();
  };

  const conversation = (
    <SideChatLayout
      store={sideChat}
      hideTodos
      renderChat={(sideChatStore, composerHeader) => (
        <NestedChat
          store={sideChatStore}
          composerHeader={composerHeader}
          parentBehavior={transcriptBehavior}
        />
      )}
    >
      {contextualChat ? (
        <NestedChat store={contextualChat} parentBehavior={transcriptBehavior} compact={false} />
      ) : (
        <Chat
          className="h-full"
          store={projectChat}
          transcriptBehavior={transcriptBehavior}
          composerHeader={
            <>
              {(selections.selections.length > 0 || selections.error) && (
                <div className="px-4 pb-2">
                  <EditorSelectionPills store={selections} />
                </div>
              )}
              {projectComposerHeader}
            </>
          }
          composerContent={projectComposerContent}
          composerLeadingAccessory={projectComposerLeadingAccessory}
        />
      )}
    </SideChatLayout>
  );

  const header = (
    <header
      className={cn(
        "flex shrink-0 select-none items-center justify-between gap-3 border-b border-border/65 bg-sidebar/30 px-4 [-webkit-app-region:drag]",
        contextualAnchor ? "min-h-[52px] flex-wrap py-2" : "h-10",
        !editor.chatSidebarVisible && !projectSidebarVisible && "pl-[84px]",
      )}
    >
      {headerLeading && (
        <div className="flex shrink-0 items-center [-webkit-app-region:no-drag]">
          {headerLeading}
        </div>
      )}
      <div className={cn("min-w-0 flex-1", contextualAnchor && "basis-48")}>
        <strong className="block truncate text-xs font-semibold text-foreground">
          {contextualAnchor ? "Chat about selection" : sessionTitle}
        </strong>
        {contextualAnchor ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {anchorTitle(contextualAnchor)}
          </p>
        ) : null}
      </div>
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]",
          contextualAnchor && "max-w-full flex-wrap",
        )}
      >
        {headerActions}
        {contextualAnchor ? (
          <Button variant="ghost" size="sm" onClick={closeContext}>
            Project chat
          </Button>
        ) : null}
      </div>
    </header>
  );

  return (
    <WorkspaceChatLayout
      workspace={
        <div className="flex h-full min-h-0 flex-col">
          {!editor.chatSidebarVisible && headerLeading && header}
          <div className="min-h-0 flex-1">
            <EmbeddedEditorPane store={editor} />
          </div>
        </div>
      }
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
          {header}
          {!contextualAnchor && conversationHeader}
          <div className="min-h-0 flex-1">{conversation}</div>
        </>
      }
    />
  );
});
