import {
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { untracked } from "r-state-tree";
import { observer } from "r-state-tree/react";
import {
  Conversation,
  VirtualizedConversation,
  type VirtualizedConversationHandle,
} from "@/components/ai-elements/conversation";
import { AnnotationDraftPopover } from "@/components/annotation-draft-popover";
import { ChatTranscriptFooter } from "./chat-transcript-footer";
import { TranscriptScroller } from "./transcript-scroller";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { SideChatContext } from "@/components/side-chat-context";
import { workLogChanges } from "../../utils/turn-diff";
import type { ChatStore, TranscriptScrollPosition } from "../stores/ChatStore";
import {
  ErrorNotice,
  TranscriptList,
  captureTranscriptSelection,
  chatWorkIsActive,
  errorNoticeFollowsUser,
  groupTranscriptParts,
  type CanonicalTranscriptBehavior,
  type ChatTranscriptBehavior,
  type TranscriptItem,
  type TranscriptSelectionCapture,
} from "./chat-transcript-parts";
import { ChatTranscriptItem } from "./chat-transcript-item";
import { transcriptItemKeys } from "./chat-transcript-items";
import { useArrivals } from "../hooks/use-arrivals";
import {
  createTranscriptScrollOwner,
  type TranscriptScrollOwner,
} from "../lib/transcript-scroll-owner";

export {
  captureMessageSelection,
  chatWorkIsActive,
  groupTranscriptParts,
  type ChatTranscriptBehavior,
  type TranscriptSelectionCapture,
} from "./chat-transcript-parts";

export interface ChatTranscriptHandle {
  /**
   * Sending a message is the only time the transcript scrolls to the bottom
   * for the reader. Nothing else may call this.
   */
  scrollToBottomForSentMessage(): void;
}

const defaultTranscriptBehavior: ChatTranscriptBehavior = {};
const selectionRevealMargin = 16;

function captureScrollPosition(scroller: HTMLElement): TranscriptScrollPosition | undefined {
  if (scroller.clientHeight <= 0) return undefined;
  const list = scroller.querySelector('[aria-label="Conversation"]');
  // Initial positioning is not a reading position, even when the scroller
  // already has dimensions. Keep the saved anchor until Virtuoso reveals it.
  if (list && getComputedStyle(list).visibility === "hidden") return undefined;
  if (scroller.scrollTop <= 1) return { kind: "top" };
  if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1)
    return { kind: "bottom" };
  const viewportTop = scroller.getBoundingClientRect().top;
  const anchor = Array.from(
    scroller.querySelectorAll<HTMLElement>("[data-transcript-anchor-id]"),
  ).find((item) => item.getBoundingClientRect().bottom > viewportTop + 1);
  const messageId = anchor?.dataset.transcriptAnchorId;
  if (!anchor || !messageId) return undefined;
  return {
    kind: "message",
    messageId,
    offset: anchor.getBoundingClientRect().top - viewportTop,
  };
}

export const ChatTranscript = observer(function ChatTranscript({
  store,
  behavior = defaultTranscriptBehavior,
  empty,
  footer,
  error: errorOverride,
  virtualized = true,
  ref,
}: {
  store: ChatStore;
  behavior?: ChatTranscriptBehavior;
  empty?: ReactNode;
  footer?: ReactNode;
  error?: { message: string; details?: string; title?: string };
  virtualized?: boolean;
  ref?: Ref<ChatTranscriptHandle>;
}) {
  useEffect(
    () => behavior.inlineArtifactPreviews?.observeConversation(store.id, () => store.parts),
    [behavior.inlineArtifactPreviews, store],
  );
  const sideChat = useContext(SideChatContext);
  const virtuosoRef = useRef<VirtualizedConversationHandle>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pendingSelectionRef = useRef<TranscriptSelectionCapture | undefined>(undefined);
  const restoredScrollPosition = useMemo(
    () => untracked(() => store.transcriptInteraction.transcriptScrollPosition),
    [store],
  );
  const [annotationDraft, setAnnotationDraft] = useState<TranscriptSelectionCapture>();
  // One owner decides every transcript scroll; see transcript-scroll-owner.ts.
  const scrollOwner = useRef<TranscriptScrollOwner | undefined>(undefined);
  const initiallyFollowing = !restoredScrollPosition || restoredScrollPosition.kind === "bottom";
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!scroller || !content) return;
    const owner = createTranscriptScrollOwner(scroller, content, {
      following: initiallyFollowing,
      cancelVirtualNavigation: () => virtuosoRef.current?.cancelScrollToIndex(),
    });
    scrollOwner.current = owner;
    return () => {
      owner.dispose();
      scrollOwner.current = undefined;
    };
  }, [initiallyFollowing, scroller]);
  const reconcileScroll = useCallback(() => scrollOwner.current?.reconcile(), []);
  const scrollToBottomForSentMessage = useCallback(
    () => scrollOwner.current?.scrollToBottomForSentMessage(),
    [],
  );
  useImperativeHandle(ref, () => ({ scrollToBottomForSentMessage }), [
    scrollToBottomForSentMessage,
  ]);
  const parts = store.parts;
  // Read disclosure state in this observer's render. VirtualizedConversation invokes
  // itemContent from its own render, outside this component's reactive tracking.
  const changedFilesOpen = store.transcriptInteraction.changedFilesOpen;
  const loadingStartedAt = store.transcriptInteraction.loadingStartedAt;
  const loadingLabel = store.contextInspector?.activityLabel;
  const visibleParts = store.hideThinking
    ? parts.filter((part) => part.kind !== "reasoning")
    : parts;
  const showAssistantLoading =
    Boolean(loadingLabel) ||
    chatWorkIsActive(
      parts,
      store.streaming,
      store.submitting,
      Boolean(
        behavior.waitingForUser || behavior.interviews?.some((interview) => interview.requested),
      ),
    );
  useLayoutEffect(() => {
    store.transcriptInteraction.syncChangedFilesOpen(showAssistantLoading);
  }, [showAssistantLoading, store]);
  const groupedParts = groupTranscriptParts(parts);
  const hasWorkLogChanges = useMemo(() => workLogChanges(parts).length > 0, [parts]);
  const visibleGroupedParts = store.hideThinking
    ? groupedParts.flatMap((item): TranscriptItem[] => {
        if (item.kind === "reasoning") return [];
        if (item.kind !== "activity-group") return [item];
        const visibleGroupParts = item.parts.filter((part) => part.kind !== "reasoning");
        return visibleGroupParts.length > 0 ? [{ ...item, parts: visibleGroupParts }] : [];
      })
    : groupedParts;
  const items: TranscriptItem[] = [
    ...visibleGroupedParts,
    ...(hasWorkLogChanges ? [{ kind: "changed-files" as const, id: "changed-files" }] : []),
    ...(showAssistantLoading ? [{ kind: "loading-state" as const, id: "loading-state" }] : []),
  ];
  const itemKeys = transcriptItemKeys(items);
  const isArriving = useArrivals(itemKeys, store.id);
  const transcriptBehavior = useMemo<CanonicalTranscriptBehavior>(
    () => ({
      store,
      ...behavior,
      openSideChat: sideChat ? (target) => sideChat.open(target) : undefined,
    }),
    [behavior, sideChat, store],
  );
  const messageSelection = store.transcriptInteraction.messageSelection;
  const selectedMessageId = store.transcriptInteraction.selectedMessageId;
  const selectedItemIndex = selectedMessageId
    ? items.findIndex((item) =>
        item.kind === "activity-group" ||
        item.kind === "source-group" ||
        item.kind === "context-group"
          ? item.parts.some((part) => part.id === selectedMessageId)
          : item.id === selectedMessageId,
      )
    : -1;
  const navigationItemIndex = messageSelection?.origin === "navigation" ? selectedItemIndex : -1;
  // Each selection revision is revealed once. A keyboard selection that survives a
  // remount keeps the restored scroll position; linked navigation reveals again.
  const revealedSelectionRevision = useRef(
    untracked(() =>
      store.transcriptInteraction.messageSelection?.origin === "keyboard"
        ? store.transcriptInteraction.messageSelection.revision
        : undefined,
    ),
  );
  const restoredMessageItemIndex =
    restoredScrollPosition?.kind === "message"
      ? items.findIndex((item) =>
          item.kind === "activity-group" ||
          item.kind === "source-group" ||
          item.kind === "context-group"
            ? item.parts.some((part) => part.id === restoredScrollPosition.messageId)
            : item.id === restoredScrollPosition.messageId,
        )
      : -1;
  const openingItemLocation = useMemo(() => {
    if (navigationItemIndex >= 0) return undefined;
    if (restoredScrollPosition?.kind === "top") return { index: 0, align: "start" as const };
    if (restoredScrollPosition?.kind === "message" && restoredMessageItemIndex >= 0)
      return {
        index: restoredMessageItemIndex,
        align: "start" as const,
        offset: -restoredScrollPosition.offset,
      };
    // Start measurement at the destination instead of painting the top and
    // scrolling afterwards. Virtuoso keeps the list hidden until its initial
    // location settles, including the footer/composer spacer at the bottom.
    // Later height changes reconcile committed geometry before paint.
    return { index: "LAST" as const, align: "end" as const };
  }, [navigationItemIndex, restoredMessageItemIndex, restoredScrollPosition]);
  const selecting = selectedMessageId !== undefined;
  useLayoutEffect(() => scrollOwner.current?.setSelecting(selecting), [scroller, selecting]);
  // The selection is identified by its stable item key, never by its index, so
  // arriving or streaming messages cannot retarget a reveal.
  const selectedItemKey = selectedItemIndex >= 0 ? itemKeys[selectedItemIndex] : undefined;
  useLayoutEffect(() => {
    const owner = scrollOwner.current;
    if (!owner || !messageSelection || selectedItemKey === undefined) return;
    if (revealedSelectionRevision.current === messageSelection.revision) return;
    // Virtuoso is mounted in the commit after the scroller; wait for its handle.
    if (virtualized && !virtuosoRef.current) return;
    revealedSelectionRevision.current = messageSelection.revision;
    // Revealing a selection is the only movement besides the reader's own.
    owner.reveal(selectedItemKey, () =>
      virtuosoRef.current?.scrollToIndex({
        index: selectedItemIndex,
        align: "start",
        behavior: "auto",
        offset: -selectionRevealMargin,
      }),
    );
  }, [messageSelection, scroller, selectedItemIndex, selectedItemKey, virtualized]);
  // Clicking anywhere outside the selected message ends the selection; clicks
  // inside it are left for actions on that message.
  useEffect(() => {
    if (selectedMessageId === undefined || !scroller) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        scroller.contains(target) &&
        target.closest('[data-slot="transcript-item"][aria-current="true"]')
      )
        return;
      store.transcriptInteraction.clearMessageSelection();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [scroller, selectedMessageId, store]);
  // Persist the reading position for session switches. This only records; the
  // scroll owner alone moves the viewport.
  useLayoutEffect(() => {
    if (!scroller) return;
    let savedPosition = untracked(() => store.transcriptInteraction.transcriptScrollPosition);
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const commitScrollPosition = () => {
      saveTimer = undefined;
      // Keep the last capture while geometry is unavailable (hidden or positioning).
      savedPosition = captureScrollPosition(scroller) ?? savedPosition;
      if (savedPosition) store.transcriptInteraction.setTranscriptScrollPosition(savedPosition);
    };
    const handleScroll = () => {
      // The scroll event can precede Virtuoso replacing its rendered range.
      savedPosition = captureScrollPosition(scroller) ?? savedPosition;
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      saveTimer = setTimeout(commitScrollPosition, 100);
    };
    scroller.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", handleScroll);
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      commitScrollPosition();
    };
  }, [scroller, store]);
  const error = errorOverride ?? store.error;
  // Right-clicking any selection inside this conversation keeps the native
  // Electron edit menu. The capture is held until that menu sends its
  // "Chat about this" action back to this transcript.
  const messageComments = behavior.messageComments;
  const openSelectionDraft = useCallback(
    (capture: TranscriptSelectionCapture) => {
      if (!messageComments || !sideChat) return;
      messageComments.prepareDraft(capture.selection);
      pendingSelectionRef.current = undefined;
      sideChat.open({
        key: `selection-draft:${store.id}`,
        title: "Side chat",
        eyebrow: () => "Selection",
        chatStore: messageComments.draftChatStore,
      });
    },
    [messageComments, sideChat, store.id],
  );
  useEffect(() => {
    const showContextMenu = behavior.showSelectionContextMenu;
    if ((!messageComments && !store.canAnnotate) || !showContextMenu) return;
    const handler = (event: MouseEvent) => {
      const target = event.target;
      pendingSelectionRef.current = undefined;
      if (!(target instanceof Node)) return;
      const targetElement = target instanceof Element ? target : target.parentElement;
      // Editing surfaces retain the ordinary native edit menu and cannot start
      // a transcript-selection workflow.
      if (
        targetElement?.closest(
          'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
        )
      )
        return;
      const capture = captureTranscriptSelection(store.parts);
      if (!capture) return;
      event.preventDefault();
      pendingSelectionRef.current = capture;
      void showContextMenu({
        canChat: Boolean(messageComments && sideChat),
        canAnnotate: Boolean(store.canAnnotate),
      })
        .then((action) => {
          if (pendingSelectionRef.current !== capture) return;
          pendingSelectionRef.current = undefined;
          if (action === "chat-about-selection") openSelectionDraft(capture);
          else if (action === "add-annotation") setAnnotationDraft(capture);
        })
        .catch(() => {
          if (pendingSelectionRef.current === capture) pendingSelectionRef.current = undefined;
        });
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, [behavior.showSelectionContextMenu, messageComments, openSelectionDraft, sideChat, store]);
  const selectionOverlays = (
    <>
      {annotationDraft && (
        <AnnotationDraftPopover
          anchor={annotationDraft.rect}
          selection={annotationDraft.selection}
          onAdd={(annotation) => store.addAnnotation(annotation)}
          onClose={() => setAnnotationDraft(undefined)}
        />
      )}
    </>
  );
  const renderItem = (item: TranscriptItem, index: number) => (
    <ChatTranscriptItem
      key={itemKeys[index]}
      itemKey={itemKeys[index] ?? item.id}
      item={item}
      index={index}
      arriving={isArriving(itemKeys[index] ?? item.id)}
      errorFollowsUser={errorNoticeFollowsUser(items, index)}
      selected={index === selectedItemIndex}
      parts={parts}
      behavior={transcriptBehavior}
      changedFilesOpen={changedFilesOpen}
      loadingStartedAt={loadingStartedAt}
      loadingLabel={loadingLabel}
    />
  );
  return (
    <>
      {selectionOverlays}
      <div
        ref={setScroller}
        // Clicking the transcript focuses it (not the body) so its pane keeps
        // keyboard message selection and keyboard scrolling. Not a tab stop.
        tabIndex={-1}
        className="transcript outline-none h-full w-full max-w-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable_both-edges] [overflow-anchor:none]"
      >
        <div ref={contentRef} className="min-w-0">
          {store.history?.hasMore && (
            <div className="grid justify-items-center gap-2 px-6 py-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={store.history.loading}
                onClick={() => void store.history?.load()}
              >
                {store.history.loading ? "Loading earlier messages…" : "Load earlier messages"}
              </Button>
              {store.history.error && <Callout variant="error">{store.history.error}</Callout>}
            </div>
          )}
          {visibleParts.length === 0 ? (
            <Conversation className="px-6 pt-[42px] pb-[210px] max-[620px]:px-4">
              {empty}
              {showAssistantLoading && (
                <LoadingState label={loadingLabel} startedAt={loadingStartedAt} />
              )}
              {footer}
              {error?.message && (
                <ErrorNotice
                  title={error.title ?? "Operation failed"}
                  message={error.message}
                  details={error.details}
                />
              )}
            </Conversation>
          ) : !virtualized ? (
            <TranscriptList>
              {items.map(renderItem)}
              <ChatTranscriptFooter context={{ footer, error }} />
            </TranscriptList>
          ) : (
            scroller && (
              <VirtualizedConversation
                ref={virtuosoRef}
                customScrollParent={scroller}
                data={items}
                context={{ footer, error, onLayout: reconcileScroll }}
                computeItemKey={(index, item) => itemKeys[index] ?? item.id}
                initialTopMostItemIndex={openingItemLocation}
                followOutput={false}
                // The transcript scroll owner anchors the reader. Virtuoso's
                // total-height compensation would also react to tail growth.
                skipUpwardScrollCompensation
                components={{
                  List: TranscriptList,
                  Footer: ChatTranscriptFooter,
                  Scroller: TranscriptScroller,
                }}
                itemContent={(index, item) => renderItem(item, index)}
              />
            )
          )}
        </div>
      </div>
    </>
  );
});
