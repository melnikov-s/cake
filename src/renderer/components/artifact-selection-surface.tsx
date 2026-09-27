import { useRef, useState, type ReactNode } from "react";
import { AnnotationDraftPopover } from "./annotation-draft-popover";
import { captureMessageSelection } from "./chat-message";
import type { MessageSelectionAnchor } from "../stores/MessageCommentsStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";

type Capture = {
  selection: MessageSelectionAnchor;
  rect: { top: number; right: number; bottom: number; left: number };
};

/** Selection actions for content in the session artifact accessory panel. */
export function ArtifactSelectionSurface({
  session,
  artifactId,
  showContextMenu,
  children,
}: {
  session: ProjectSessionStore;
  artifactId: string;
  showContextMenu(input: {
    canChat: boolean;
    canAnnotate: boolean;
  }): Promise<"chat-about-selection" | "add-annotation" | undefined>;
  children: ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const pending = useRef<Capture | undefined>(undefined);
  const [annotationDraft, setAnnotationDraft] = useState<Capture>();
  const comments = session.messageCommentsStore;
  const sideChat = session.conversationSessionStore.sideChatStore;
  const openDraft = (capture: Capture) => {
    comments.prepareDraft(capture.selection);
    sideChat.open({
      key: `artifact-selection-draft:${session.sessionId}`,
      title: "Side chat",
      eyebrow: () => "Artifact selection",
      chatStore: comments.draftChatStore,
    });
  };
  return (
    <div
      ref={surface}
      onContextMenu={(event) => {
        pending.current = undefined;
        const container = surface.current;
        const browser = window.getSelection();
        if (!container || !browser || browser.isCollapsed || browser.rangeCount === 0) return;
        const range = browser.getRangeAt(0);
        if (!(event.target instanceof Node) || !container.contains(event.target)) return;
        if (!container.contains(range.startContainer) || !container.contains(range.endContainer))
          return;
        const targetElement =
          event.target instanceof Element ? event.target : event.target.parentElement;
        if (
          targetElement?.closest(
            'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
          )
        )
          return;
        const selection = captureMessageSelection(container, artifactId);
        if (!selection) return;
        const end = Array.from(range.getClientRects()).at(-1) ?? range.getBoundingClientRect();
        const capture = {
          selection: { ...selection, artifactId },
          rect: { top: end.top, right: end.right, bottom: end.bottom, left: end.left },
        };
        pending.current = capture;
        event.preventDefault();
        event.stopPropagation();
        void showContextMenu({ canChat: true, canAnnotate: true })
          .then((action) => {
            if (pending.current !== capture) return;
            pending.current = undefined;
            if (action === "chat-about-selection") openDraft(capture);
            if (action === "add-annotation") setAnnotationDraft(capture);
          })
          .catch(() => {
            if (pending.current === capture) pending.current = undefined;
          });
      }}
    >
      {children}
      {annotationDraft && (
        <AnnotationDraftPopover
          anchor={annotationDraft.rect}
          selection={annotationDraft.selection}
          onAdd={(annotation) => {
            session.conversationSessionStore.composerStore.draftStore.annotationDraft.add(
              annotation,
            );
            setAnnotationDraft(undefined);
          }}
          onClose={() => setAnnotationDraft(undefined)}
        />
      )}
    </div>
  );
}
