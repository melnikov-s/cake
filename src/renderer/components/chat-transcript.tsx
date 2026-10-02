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
import { useStickToBottom } from "use-stick-to-bottom";
import { untracked } from "r-state-tree";
import { observer } from "r-state-tree/react";
import {
  Conversation,
  VirtualizedConversation,
  type VirtualizedConversationHandle,
} from "@/components/ai-elements/conversation";
import { AnnotationDraftPopover } from "@/components/annotation-draft-popover";
import { ChatTranscriptFooter } from "./chat-transcript-footer";
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

export {
  captureMessageSelection,
  chatWorkIsActive,
  groupTranscriptParts,
  type ChatTranscriptBehavior,
  type TranscriptSelectionCapture,
} from "./chat-transcript-parts";

export interface ChatTranscriptHandle {
  scrollToBottom(): void;
}

const defaultTranscriptBehavior: ChatTranscriptBehavior = {};

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
  const sideChat = useContext(SideChatContext);
  const virtuosoRef = useRef<VirtualizedConversationHandle>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const pendingSelectionRef = useRef<TranscriptSelectionCapture | undefined>(undefined);
  const restoredScrollPosition = useMemo(
    () => untracked(() => store.transcriptInteraction.transcriptScrollPosition),
    [store],
  );
  const [annotationDraft, setAnnotationDraft] = useState<TranscriptSelectionCapture>();
  const {
    scrollRef,
    contentRef,
    scrollToBottom: scrollCompactToBottom,
    stopScroll,
  } = useStickToBottom({
    initial:
      restoredScrollPosition || store.transcriptInteraction.messageNavigationRequest
        ? false
        : "instant",
    resize: "instant",
  });
  const atBottom = useRef(!restoredScrollPosition || restoredScrollPosition.kind === "bottom");
  const bottomFrame = useRef<number | undefined>(undefined);
  const allowFollowing = useRef(true);
  const handleTotalHeightChange = useCallback(() => {
    if (!atBottom.current || !scroller || bottomFrame.current !== undefined) return;
    // Virtuoso's scrollToIndex retries as row measurements change, even after
    // upward input cancels following. Align the committed DOM once instead and
    // check user intent again before applying this frame's correction.
    bottomFrame.current = requestAnimationFrame(() => {
      bottomFrame.current = undefined;
      if (!atBottom.current) return;
      scroller.scrollTop = scroller.scrollHeight;
    });
  }, [scroller]);
  useLayoutEffect(
    () => () => {
      if (bottomFrame.current !== undefined) cancelAnimationFrame(bottomFrame.current);
      bottomFrame.current = undefined;
    },
    [scroller],
  );
  const scrollToBottom = useCallback(() => {
    allowFollowing.current = true;
    atBottom.current = true;
    if (virtualized) handleTotalHeightChange();
    else void scrollCompactToBottom("instant");
  }, [handleTotalHeightChange, scrollCompactToBottom, virtualized]);
  useImperativeHandle(ref, () => ({ scrollToBottom }), [scrollToBottom]);
  const attachScroller = useCallback(
    (element: HTMLDivElement | null) => {
      if (!virtualized) scrollRef(element);
      setScroller(element);
    },
    [scrollRef, virtualized],
  );
  const parts = store.parts;
  // Read disclosure state in this observer's render. VirtualizedConversation invokes
  // itemContent from its own render, outside this component's reactive tracking.
  const changedFilesOpen = store.transcriptInteraction.changedFilesOpen;
  const loadingStartedAt = store.transcriptInteraction.loadingStartedAt;
  const visibleParts = store.hideThinking
    ? parts.filter((part) => part.kind !== "reasoning")
    : parts;
  const showAssistantLoading = chatWorkIsActive(
    parts,
    store.streaming,
    store.submitting,
    Boolean(behavior.waitingForUser || behavior.artifacts?.interaction.request),
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
  const transcriptBehavior = useMemo<CanonicalTranscriptBehavior>(
    () => ({
      store,
      ...behavior,
      openSideChat: sideChat ? (target) => sideChat.open(target) : undefined,
    }),
    [behavior, sideChat, store],
  );
  const messageNavigationRequest = store.transcriptInteraction.messageNavigationRequest;
  const messageNavigationItemIndex = messageNavigationRequest
    ? items.findIndex((item) =>
        item.kind === "activity-group" || item.kind === "source-group"
          ? item.parts.some((part) => part.id === messageNavigationRequest.messageId)
          : item.id === messageNavigationRequest.messageId,
      )
    : -1;
  const restoredMessageItemIndex =
    restoredScrollPosition?.kind === "message"
      ? items.findIndex((item) =>
          item.kind === "activity-group" || item.kind === "source-group"
            ? item.parts.some((part) => part.id === restoredScrollPosition.messageId)
            : item.id === restoredScrollPosition.messageId,
        )
      : -1;
  const itemCount = items.length;
  const openingItemLocation = useMemo(() => {
    if (messageNavigationItemIndex >= 0) return undefined;
    if (restoredScrollPosition?.kind === "top") return { index: 0, align: "start" as const };
    if (restoredScrollPosition?.kind === "message" && restoredMessageItemIndex >= 0)
      return {
        index: restoredMessageItemIndex,
        align: "start" as const,
        offset: -restoredScrollPosition.offset,
      };
    // Normal bottom opening uses the same cancellable alignment as streaming.
    // Virtuoso retries initial index navigation too, which can otherwise pull a
    // user back down immediately after opening a session. Only use it as a
    // fallback when a saved history anchor no longer exists.
    return restoredScrollPosition?.kind === "message"
      ? { index: itemCount - 1, align: "end" as const }
      : undefined;
  }, [itemCount, messageNavigationItemIndex, restoredMessageItemIndex, restoredScrollPosition]);
  useLayoutEffect(() => {
    if (!messageNavigationRequest || messageNavigationItemIndex < 0) return;
    allowFollowing.current = false;
    atBottom.current = false;
    if (!virtualized) stopScroll();
    if (virtualized)
      virtuosoRef.current?.scrollToIndex({
        index: messageNavigationItemIndex,
        align: "center",
        behavior: "auto",
      });
    else
      scroller
        ?.querySelector<HTMLElement>(`[data-transcript-item-index="${messageNavigationItemIndex}"]`)
        ?.scrollIntoView({ block: "center" });
  }, [messageNavigationItemIndex, messageNavigationRequest, scroller, stopScroll, virtualized]);
  useLayoutEffect(() => {
    if (!scroller) return;
    let pendingPosition = untracked(() => store.transcriptInteraction.transcriptScrollPosition);
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let draggingScrollbar = false;
    let previousTop = scroller.scrollTop;
    const pauseFollowing = () => {
      allowFollowing.current = false;
      atBottom.current = false;
      if (!virtualized) stopScroll();
    };
    const captureScrollPosition = (): TranscriptScrollPosition | undefined => {
      if (scroller.clientHeight <= 0) return undefined;
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
    };
    const commitScrollPosition = () => {
      saveTimer = undefined;
      if (pendingPosition) store.transcriptInteraction.setTranscriptScrollPosition(pendingPosition);
    };
    const captureAndSchedule = () => {
      pendingPosition = captureScrollPosition();
      if (draggingScrollbar) {
        if (scroller.scrollTop < previousTop) pauseFollowing();
        else if (scroller.scrollTop > previousTop) allowFollowing.current = true;
      }
      previousTop = scroller.scrollTop;
      // A queued bottom event can arrive after upward input. Only a subsequent
      // downward gesture or an explicit request may enable following again.
      // Scroll events alone are ambiguous: Virtuoso also moves during measurement.
      if (pendingPosition?.kind === "bottom" && allowFollowing.current) atBottom.current = true;
      if (!pendingPosition) return;
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      saveTimer = setTimeout(commitScrollPosition, 100);
    };
    const handleScrollIntent = (target: EventTarget | null, direction: number) => {
      if (direction === 0) return;
      if (!(target instanceof Element)) return;
      let ancestor: Element | null = target;
      while (ancestor && ancestor !== scroller) {
        if (ancestor instanceof HTMLElement) {
          const style = getComputedStyle(ancestor);
          if (["auto", "scroll"].includes(style.overflowY)) {
            const canScroll =
              direction < 0
                ? ancestor.scrollTop > 0
                : ancestor.scrollTop + ancestor.clientHeight < ancestor.scrollHeight;
            // An uncontained nested scroller at its boundary chains to the
            // transcript; that gesture must cancel outer following too.
            if (canScroll || ["contain", "none"].includes(style.overscrollBehaviorY)) return;
          }
        }
        ancestor = ancestor.parentElement;
      }
      if (direction < 0) pauseFollowing();
      else {
        allowFollowing.current = true;
        if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1)
          atBottom.current = true;
      }
    };
    const handleWheel = (event: WheelEvent) => handleScrollIntent(event.target, event.deltaY);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.target instanceof Element) ||
        event.target.closest('input, textarea, select, [contenteditable="true"]')
      )
        return;
      if (
        ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
        (event.key === " " && event.shiftKey)
      )
        handleScrollIntent(event.target, -1);
      else if (["ArrowDown", "PageDown", "End", " "].includes(event.key))
        handleScrollIntent(event.target, 1);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target !== scroller) return;
      const x = event.clientX - scroller.getBoundingClientRect().left;
      if (x >= scroller.clientLeft && x < scroller.clientLeft + scroller.clientWidth) return;
      draggingScrollbar = true;
      previousTop = scroller.scrollTop;
      pauseFollowing();
    };
    const handlePointerUp = () => {
      draggingScrollbar = false;
    };
    scroller.addEventListener("wheel", handleWheel, { passive: true });
    scroller.addEventListener("keydown", handleKeyDown);
    scroller.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    scroller.addEventListener("scroll", captureAndSchedule, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", handleWheel);
      scroller.removeEventListener("keydown", handleKeyDown);
      scroller.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      scroller.removeEventListener("scroll", captureAndSchedule);
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      if (pendingPosition) store.transcriptInteraction.setTranscriptScrollPosition(pendingPosition);
    };
  }, [scroller, stopScroll, store, virtualized]);
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
      item={item}
      index={index}
      errorFollowsUser={errorNoticeFollowsUser(items, index)}
      parts={parts}
      behavior={transcriptBehavior}
      changedFilesOpen={changedFilesOpen}
      loadingStartedAt={loadingStartedAt}
    />
  );
  return (
    <>
      {selectionOverlays}
      <div
        ref={attachScroller}
        className="transcript h-full w-full max-w-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable_both-edges] [overflow-anchor:none]"
      >
        <div ref={virtualized ? undefined : contentRef} className="min-w-0">
          {visibleParts.length === 0 ? (
            <Conversation className="px-6 pt-[42px] pb-[210px] max-[620px]:px-4">
              {empty}
              {showAssistantLoading && <LoadingState startedAt={loadingStartedAt} />}
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
                context={{ footer, error }}
                computeItemKey={(index, item) => itemKeys[index] ?? item.id}
                initialTopMostItemIndex={openingItemLocation}
                followOutput={false}
                totalListHeightChanged={handleTotalHeightChange}
                components={{ List: TranscriptList, Footer: ChatTranscriptFooter }}
                itemContent={(index, item) => renderItem(item, index)}
              />
            )
          )}
        </div>
      </div>
    </>
  );
});
