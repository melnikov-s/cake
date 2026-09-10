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
  const scrollToBottom = useCallback(() => {
    atBottom.current = true;
    if (virtualized)
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
    else void scrollCompactToBottom("instant");
  }, [scrollCompactToBottom, virtualized]);
  useImperativeHandle(ref, () => ({ scrollToBottom }), [scrollToBottom]);
  const handleBottomStateChange = useCallback((value: boolean) => {
    atBottom.current = value;
  }, []);
  const handleTotalHeightChange = useCallback(() => {
    if (atBottom.current)
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
  }, []);
  const attachScroller = useCallback(
    (element: HTMLDivElement | null) => {
      if (!virtualized) scrollRef(element);
      setScroller(element);
    },
    [scrollRef, virtualized],
  );
  const parts = store.parts;
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
    return { index: itemCount - 1, align: "end" as const };
  }, [itemCount, messageNavigationItemIndex, restoredMessageItemIndex, restoredScrollPosition]);
  useLayoutEffect(() => {
    if (!messageNavigationRequest || messageNavigationItemIndex < 0) return;
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
      if (pendingPosition) atBottom.current = pendingPosition.kind === "bottom";
      if (!pendingPosition) return;
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      saveTimer = setTimeout(commitScrollPosition, 100);
    };
    scroller.addEventListener("scroll", captureAndSchedule, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", captureAndSchedule);
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      if (pendingPosition) store.transcriptInteraction.setTranscriptScrollPosition(pendingPosition);
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
        title: "Chat about this",
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
      key={item.id}
      item={item}
      index={index}
      errorFollowsUser={errorNoticeFollowsUser(items, index)}
      parts={parts}
      behavior={transcriptBehavior}
      changedFilesOpen={store.transcriptInteraction.changedFilesOpen}
      loadingStartedAt={store.transcriptInteraction.loadingStartedAt}
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
              {showAssistantLoading && (
                <LoadingState startedAt={store.transcriptInteraction.loadingStartedAt} />
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
                context={{ footer, error }}
                computeItemKey={(_index, item) => item.id}
                initialTopMostItemIndex={openingItemLocation}
                followOutput={false}
                atBottomStateChange={handleBottomStateChange}
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
