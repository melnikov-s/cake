import { observer } from "r-state-tree/react";
import type { ChatTranscriptBehavior } from "./chat-message";
import type { ChatStore } from "../stores/ChatStore";
import type { EmbeddedEditorStore } from "../stores/EmbeddedEditorStore";
import type { ReviewsStore } from "../stores/ReviewsStore";
import { BackIcon } from "./ui/icons";
import { Button } from "./ui/button";
import { Chat } from "./chat";
import { EmbeddedEditorPane } from "./embedded-editor";

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
  transcriptBehavior,
  onBack,
}: {
  editor: EmbeddedEditorStore;
  reviews: ReviewsStore;
  projectChat: ChatStore;
  transcriptBehavior: ChatTranscriptBehavior;
  onBack(): void;
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

  return (
    <main className="flex h-screen min-h-0 w-screen overflow-hidden bg-background text-foreground">
      <section className="min-w-0 flex-1" aria-label="VS Code workspace">
        <EmbeddedEditorPane store={editor} />
      </section>
      <aside className="flex w-[min(420px,42vw)] min-w-[320px] flex-col border-l border-border bg-background shadow-[-12px_0_32px_color-mix(in_oklab,var(--foreground)_8%,transparent)]">
        <header className="flex min-h-14 items-center justify-between gap-3 border-b border-border px-3 py-2">
          <div className="min-w-0">
            <strong className="block truncate text-sm">
              {contextualAnchor ? "Chat about selection" : "Cake Agent"}
            </strong>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">
              {contextualAnchor
                ? anchorTitle(contextualAnchor)
                : (editor.lastActivePath ?? "Project chat")}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {contextualAnchor ? (
              <Button variant="ghost" size="sm" onClick={closeContext}>
                Project chat
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={onBack}>
              <BackIcon aria-hidden />
              Back to Agent
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1">
          <Chat store={chat} transcriptBehavior={transcriptBehavior} />
        </div>
      </aside>
    </main>
  );
});
