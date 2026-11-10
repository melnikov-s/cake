import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { untracked } from "r-state-tree";
import { observer } from "r-state-tree/react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { Conversation } from "@/components/ai-elements/conversation";
import { AnnotationDraftPopover } from "@/components/annotation-draft-popover";
import { ChatTranscriptFooter, type ChatTranscriptFooterError } from "./chat-transcript-footer";
import { ConversationMarkdownProvider } from "./conversation-markdown-provider";
import { FullscreenTranscriptContext } from "./fullscreen-transcript-context";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { SideChatContext } from "@/components/side-chat-context";
import type { ChatStore, TranscriptScrollPosition } from "../stores/ChatStore";
import {
  ErrorNotice,
  captureTranscriptSelection,
  chatWorkIsActive,
  errorNoticeFollowsUser,
  groupTranscriptParts,
  type CanonicalTranscriptBehavior,
  type ChatTranscriptBehavior,
  type TranscriptItem,
  type TranscriptSelectionCapture,
} from "./chat-transcript-parts";
import { transcriptItemParts, type TranscriptContentPart } from "./chat-transcript-items";
import { ChatTranscriptItem, transcriptAnchorId } from "./chat-transcript-item";
import { transcriptItemKeys } from "./chat-transcript-items";
import { transcriptTaskSections } from "../lib/transcript-task-sections";
import {
  transcriptPresentationRows,
  type TranscriptPresentationRow,
} from "../lib/transcript-presentation-rows";
import { TaskSectionRail } from "./task-section-rail";
import { todoMessageMatches } from "../lib/todo-message-matches";
import { resultTodoOrigin, referenceTodoOrigin } from "../lib/result-todo-origin";
import {
  isCakeChatSessionId,
  isProjectChatSessionId,
  cakeChatSideChatParentId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { useArrivals } from "../hooks/use-arrivals";
import { useTranscriptFollow } from "../lib/transcript-follow";

export {
  captureMessageSelection,
  type ChatTranscriptBehavior,
  type TranscriptSelectionCapture,
} from "./chat-transcript-parts";

export interface TranscriptBottomNavigation {
  conversationId: string;
  jumpToBottom(): void;
}

const defaultTranscriptBehavior: ChatTranscriptBehavior = {};
const selectionRevealMargin = 16;

function revealMargin(list: LegendListRef, key: string) {
  const state = list.getState();
  const index = state.indexByKey(key);
  if (index === undefined) return selectionRevealMargin;
  // Only explicit navigation needs this scan; scrolling itself stays list-owned.
  for (let i = index - 1; i >= 0; i--) {
    // SAFETY: this ref belongs exclusively to LegendList<TranscriptRow> below.
    const row = state.data[i] as TranscriptRow;
    if (row.kind === "section-end") break;
    if (row.kind === "task-heading") return selectionRevealMargin + state.sizeAtIndex(i);
  }
  return selectionRevealMargin;
}
// LegendList paint containment would clip the heading’s existing narrow-pane
// outdent and keyboard rings. Relax it only for header containers; isolate their z-order.
const scrollerClassName =
  "transcript isolate @container/transcript outline-none h-full w-full max-w-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable_both-edges] [overflow-anchor:none] [&_:has(>[data-slot=task-section-header])]:[contain:layout_style]!";

type TranscriptRow = TranscriptPresentationRow<TranscriptItem>;

/** Records where the reader is, for reopening this conversation; never moves anything. */
function captureScrollPosition(
  list: LegendListRef,
  anchorIds: ReadonlyMap<string, { messageId: string | undefined; key: string }>,
): TranscriptScrollPosition | undefined {
  // Undefined until the list finished its initial placement: that is not a reading position.
  const anchor = list.anchorVisibleContent({ hold: false });
  const state = list.getState();
  if (!anchor || state.scrollLength <= 0) return undefined;
  if (state.distanceFromEnd <= 1) return { kind: "bottom" };
  if (state.scroll <= 1) return { kind: "top" };
  const target = anchorIds.get(anchor.key);
  const position = target && list.anchorVisibleContent({ key: target.key, hold: false });
  return target?.messageId && position
    ? { kind: "message", messageId: target.messageId, offset: -position.offset }
    : undefined;
}

export const ChatTranscript = observer(function ChatTranscript({
  store,
  behavior = defaultTranscriptBehavior,
  empty,
  footer,
  error: errorOverride,
  annotationSubmitFocusRef,
  onBottomNavigationChange,
}: {
  store: ChatStore;
  behavior?: ChatTranscriptBehavior;
  empty?: ReactNode;
  footer?: ReactNode;
  error?: { message: string; details?: string; title?: string };
  annotationSubmitFocusRef?: RefObject<HTMLElement | null>;
  onBottomNavigationChange?(navigation: TranscriptBottomNavigation | undefined): void;
}) {
  useEffect(() => store.retainTranscript(), [store]);
  useEffect(() => () => store.transcriptInteraction.cancelResultReveal(), [store]);
  useEffect(
    () => behavior.inlineArtifactPreviews?.observeConversation(store.id, () => store.parts),
    [behavior.inlineArtifactPreviews, store],
  );
  const sideChat = useContext(SideChatContext);
  const [presentedFullscreens, setPresentedFullscreens] = useState(0);
  const fullscreenTranscript = useMemo(
    () => ({
      retain() {
        setPresentedFullscreens((count) => count + 1);
        return () => setPresentedFullscreens((count) => count - 1);
      },
    }),
    [],
  );
  const uncoveredExpansion = useRef(new Map<string, boolean>());
  const listRef = useRef<LegendListRef | null>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const attachList = useCallback((list: LegendListRef | null) => {
    listRef.current = list;
    setScroller(list?.getScrollableNode() ?? null);
  }, []);
  const pendingSelectionRef = useRef<TranscriptSelectionCapture | undefined>(undefined);
  const restoredScrollPosition = useMemo(
    () => untracked(() => store.transcriptInteraction.transcriptScrollPosition),
    [store],
  );
  const [annotationDraft, setAnnotationDraft] = useState<TranscriptSelectionCapture>();
  const supportsTodoFocus = Boolean(
    (isCakeChatSessionId(store.id) || cakeChatSideChatParentId(store.id)) && behavior.todos,
  );
  const focusedTodos = supportsTodoFocus ? (behavior.todos?.focusedItems ?? []) : [];
  const focused = focusedTodos.length > 0;
  const history = store.history;
  const matchingParts = focused
    ? store.parts.filter((part) =>
        focusedTodos.some((todo) => todoMessageMatches(part, store.id, todo)),
      )
    : store.parts;
  // Keep the message owning an open fullscreen reader mounted until it closes.
  const uncoveredParts = useRef(matchingParts);
  const matchedPartIds = new Set(
    (presentedFullscreens ? uncoveredParts.current : matchingParts).map((part) => part.id),
  );
  useLayoutEffect(() => {
    if (!presentedFullscreens) uncoveredParts.current = matchingParts;
  });
  const parts = store.parts;
  const loadingStartedAt = store.transcriptInteraction.loadingStartedAt;
  const loadingLabel = store.contextInspector?.activityLabel;
  const visibleParts = store.hideThinking
    ? parts.filter((part) => part.kind !== "reasoning")
    : parts;
  const showAssistantLoading =
    !focused &&
    (Boolean(loadingLabel) ||
      chatWorkIsActive(
        parts,
        store.streaming,
        store.submitting,
        Boolean(
          behavior.waitingForUser || behavior.interviews?.some((interview) => interview.requested),
        ),
      ));
  const groupedParts = groupTranscriptParts(parts);
  const visibleGroupedParts = store.hideThinking
    ? groupedParts.flatMap((item): TranscriptItem[] => {
        if (item.kind === "reasoning") return [];
        if (item.kind !== "activity-group" && item.kind !== "original-history") return [item];
        const visibleGroupParts = item.parts.filter((part) => part.kind !== "reasoning");
        return visibleGroupParts.length > 0 ? [{ ...item, parts: visibleGroupParts }] : [];
      })
    : groupedParts;
  const allItems: TranscriptItem[] = [
    ...visibleGroupedParts,
    ...(showAssistantLoading ? [{ kind: "loading-state" as const, id: "loading-state" }] : []),
  ];
  const allItemKeys = transcriptItemKeys(allItems);
  const matchesFocus = (item: TranscriptItem) =>
    !focused || transcriptItemParts(item).some((part) => matchedPartIds.has(part.id));
  const resultReveal = store.transcriptInteraction.resultReveal;
  const resultMessage = store.transcriptInteraction.resultMessage;
  const resultPartId = resultMessage?.id;
  useLayoutEffect(() => {
    if (resultReveal && resultMessage)
      store.transcriptInteraction.bindResultMessage(resultReveal.revision, resultMessage);
  }, [resultReveal, resultMessage, store]);
  const selectedMessageId = store.transcriptInteraction.selectedMessageId;
  const messageSelection = store.transcriptInteraction.messageSelection;
  // Each selection revision is revealed once. A keyboard selection that survives a
  // remount keeps the restored scroll position; linked navigation reveals again.
  const revealedSelectionRevision = useRef(
    untracked(() =>
      store.transcriptInteraction.messageSelection?.origin === "keyboard"
        ? store.transcriptInteraction.messageSelection.revision
        : undefined,
    ),
  );
  const taskSections =
    supportsTodoFocus && behavior.todos
      ? transcriptTaskSections(allItems, (item) => {
          if (focused) {
            const parts = transcriptItemParts(item);
            return focusedTodos.find((todo) =>
              parts.some((part) => todoMessageMatches(part, store.id, todo)),
            )?.id;
          }
          const origin =
            item.kind === "tool" && item.messageReference
              ? referenceTodoOrigin(item.messageReference)
              : item.kind === "text"
                ? resultTodoOrigin(item, store.id)
                : undefined;
          const linked = origin ? behavior.todos?.itemsForResult(origin) : undefined;
          return linked?.length === 1 ? linked[0]?.id : undefined;
        })
      : undefined;
  // Resolve explicit task focus only among exact matches,
  // after the focus change has committed. Message navigation owns expansion and
  // offscreen/virtualized reveals; background updates never create a request.
  useLayoutEffect(() => {
    const todos = behavior.todos;
    const request = todos?.transcriptFocusRequest;
    if (!request || !taskSections) return;
    const target = allItems.findLast(
      (item, index) =>
        item.kind !== "loading-state" &&
        matchesFocus(item) &&
        (focused || taskSections.sections[index]?.todoId === request.todoId),
    );
    if (!target && (history?.hasMore || history?.loading)) return;
    todos.completeTranscriptFocusRequest();
    if (!target) return;
    const messageId =
      "parts" in target
        ? transcriptItemParts(target).findLast((part) => !focused || matchedPartIds.has(part.id))
            ?.id
        : target.id;
    if (messageId) store.transcriptInteraction.navigateToMessage(messageId);
  });
  // Keep section chronology and manual folding; focus removes unrelated rows entirely.
  // Filtering the view avoids zero-height rows in the virtualizer.
  const sectionViews = taskSections?.sections.map((section, index) => {
    const todoId = section.todoId;
    if (!todoId || !behavior.todos?.value?.items.some((todo) => todo.id === todoId))
      return undefined;
    const key = JSON.stringify([store.id, allItemKeys[section.startIndex], todoId]);
    return {
      ...section,
      key,
      // Defer covered folding changes, including newly attributed sections.
      // Expanding previously hidden rows can also virtualize away the owner.
      expanded:
        (presentedFullscreens ? uncoveredExpansion.current.get(allItemKeys[index]!) : undefined) ??
        behavior.todos.transcriptSectionExpanded(key, todoId),
    };
  });
  useLayoutEffect(() => {
    if (presentedFullscreens || !taskSections) return;
    uncoveredExpansion.current = new Map(
      allItemKeys.map((key, index) => [key, sectionViews?.[index]?.expanded ?? true]),
    );
  });
  const revealMessageId = resultPartId ?? selectedMessageId;
  const selectedHiddenSection = revealMessageId
    ? sectionViews?.[
        allItems.findIndex((item) =>
          transcriptItemParts(item).some((part) => part.id === revealMessageId),
        )
      ]
    : undefined;
  const revealSectionKey =
    selectedHiddenSection &&
    !selectedHiddenSection.expanded &&
    (resultPartId !== undefined || revealedSelectionRevision.current !== messageSelection?.revision)
      ? selectedHiddenSection.key
      : undefined;
  // Message links and keyboard navigation must still reveal folded messages.
  useLayoutEffect(() => {
    if (revealSectionKey) behavior.todos?.expandTranscriptSection(revealSectionKey);
  }, [behavior.todos, revealSectionKey]);
  let previousFocusedSectionKey: string | undefined;
  const visibleIndices = allItems.flatMap((item, index) => {
    if (!matchesFocus(item)) return [];
    const section = sectionViews?.[index];
    const firstMatch = focused && section && section.key !== previousFocusedSectionKey;
    previousFocusedSectionKey = section?.key;
    return !section || section.start || firstMatch || section.expanded ? [index] : [];
  });
  const items = visibleIndices.map((index) => {
    const item = allItems[index]!;
    // Task focus matches exact tagged parts, not neighboring submitted content.
    if (focused && "userContent" in item)
      return {
        ...item,
        userContent: item.userContent?.filter((part) => matchedPartIds.has(part.id)),
      };
    if (!focused || (item.kind !== "original-history" && item.kind !== "side-chat-import"))
      return item;
    // Group containers must not leak their untagged siblings into focused chat.
    return {
      ...item,
      parts: item.parts
        .filter((part) =>
          transcriptItemParts(part).some((content) => matchedPartIds.has(content.id)),
        )
        .map((part: TranscriptContentPart) =>
          "userContent" in part
            ? {
                ...part,
                userContent: part.userContent?.filter((content) => matchedPartIds.has(content.id)),
              }
            : part,
        ),
    };
  });
  const itemKeys = visibleIndices.map((index) => allItemKeys[index]!);
  const visibleSectionViews = visibleIndices.map((index, visibleIndex) => {
    const section = sectionViews?.[index];
    if (!focused || !section) return section;
    const previous = visibleIndices[visibleIndex - 1];
    // A hidden attachment may have owned the heading; move it to the first match.
    return {
      ...section,
      start: previous === undefined || sectionViews?.[previous]?.key !== section.key,
    };
  });
  const { rows, stickyIndices, messageIndices } = transcriptPresentationRows(
    items,
    itemKeys,
    visibleSectionViews,
  );
  const resultItemIndex = resultPartId
    ? items.findIndex((item) => transcriptItemParts(item).some((part) => part.id === resultPartId))
    : -1;
  const resultItemKey = resultItemIndex < 0 ? undefined : itemKeys[resultItemIndex];
  // Explicit navigation may need an older original; Focus retrieves all repeated
  // turns, even with recent matches. Reuse the owned pager, stopping on clear/error.
  const historyLoading = history?.loading;
  const historyHasMore = history?.hasMore;
  const historyError = history?.error;
  useEffect(() => {
    if (
      (!focused &&
        (resultReveal?.source !== "history" ||
          !(resultReveal.partIds?.length || resultReveal.messageId) ||
          resultPartId)) ||
      !historyHasMore ||
      historyLoading ||
      historyError
    )
      return;
    void history?.load();
  }, [focused, resultReveal, resultPartId, history, historyLoading, historyHasMore, historyError]);
  const isArriving = useArrivals(itemKeys, store.id);
  const transcriptBehavior = useMemo<CanonicalTranscriptBehavior>(
    () => ({
      store,
      ...behavior,
      // Gate by the displayed conversation, not its shared to-do owner or link target.
      hideTodoAssociations: !isProjectChatSessionId(store.id),
      openSideChat: sideChat ? (target) => sideChat.open(target) : undefined,
    }),
    [behavior, sideChat, store],
  );
  // The composer already responds to the newest conversational text. Find it
  // before utility/loading rows and regardless of entry id or streaming status.
  const latestMessageId = visibleGroupedParts.findLast(
    (item) =>
      item.kind === "text" &&
      (item.role === "user" || Boolean(item.text) || Boolean(item.subagentReport)),
  )?.id;
  const latestMessageBehavior = useMemo<CanonicalTranscriptBehavior>(
    () => ({ ...transcriptBehavior, onReplyToMessage: undefined }),
    [transcriptBehavior],
  );
  const selectedItemIndex = selectedMessageId
    ? items.findIndex((item) =>
        transcriptItemParts(item).some((part) => part.id === selectedMessageId),
      )
    : -1;
  const navigationItemIndex = messageSelection?.origin === "navigation" ? selectedItemIndex : -1;
  const selecting = selectedMessageId !== undefined;
  const covered = presentedFullscreens > 0;
  // The only place that decides when new output moves the viewport.
  const follow = useTranscriptFollow({
    list: listRef,
    scroller,
    paused: selecting || covered,
    initiallyFollowing: !restoredScrollPosition || restoredScrollPosition.kind === "bottom",
  });
  const { followEnd, stopFollowing } = follow;
  // The opening position belongs to this list's mount; later movement is the reader's or an
  // explicit navigation below.
  const opening = useRef<
    { atEnd: true } | { atEnd: false; index: number; viewOffset: number } | undefined
  >(undefined);
  if (!opening.current && items.length > 0) {
    const restoredIndex =
      restoredScrollPosition?.kind === "message"
        ? items.findIndex((item) => transcriptAnchorId(item) === restoredScrollPosition.messageId)
        : -1;
    opening.current =
      navigationItemIndex >= 0
        ? {
            atEnd: false,
            index: messageIndices[navigationItemIndex]!,
            viewOffset: selectionRevealMargin,
          }
        : restoredScrollPosition?.kind === "top"
          ? { atEnd: false, index: 0, viewOffset: 0 }
          : restoredScrollPosition?.kind === "message" && restoredIndex >= 0
            ? {
                atEnd: false,
                index: messageIndices[restoredIndex]!,
                viewOffset: restoredScrollPosition.offset,
              }
            : { atEnd: true };
  }
  // The jump-to-bottom control and arrowing past the newest message are
  // explicit requests for the newest content; sending preserves the reading position.
  const bottomRequest = store.transcriptInteraction.bottomRequestRevision;
  const handledBottomRequest = useRef(bottomRequest);
  useLayoutEffect(() => {
    if (handledBottomRequest.current === bottomRequest) return;
    handledBottomRequest.current = bottomRequest;
    // A covered transcript must keep the row that owns the fullscreen reader mounted.
    if (!covered) followEnd();
  }, [bottomRequest, covered, followEnd]);
  const jumpVisible = follow.jumpVisible && !covered;
  useEffect(() => {
    if (!jumpVisible || !scroller) return;
    onBottomNavigationChange?.({
      conversationId: store.id,
      jumpToBottom() {
        store.transcriptInteraction.returnToBottom();
        // The control disappears at its destination; keep keyboard scrolling
        // available instead of leaving focus on an unmounted button/the body.
        scroller.focus({ preventScroll: true });
      },
    });
    return () => onBottomNavigationChange?.(undefined);
  }, [jumpVisible, onBottomNavigationChange, scroller, store]);
  // An explicit attention click waits for its exact result, then shows its start.
  const revealedResult = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!resultReveal) return;
    const revision = resultReveal.revision;
    const target = `${revision}:${resultItemKey}`;
    if (revealedResult.current === target) return;
    revealedResult.current = target;
    stopFollowing();
    if (resultItemKey === undefined) return;
    // Reader input ends the reveal (`onUserScroll`); until then a re-keyed result is shown again.
    const list = listRef.current;
    if (list)
      void list.scrollToKey({
        key: resultItemKey,
        animated: false,
        viewOffset: revealMargin(list, resultItemKey),
      });
  }, [resultReveal, resultItemKey, stopFollowing]);
  // Earlier pages load only when the reader scrolls toward the start, one page
  // per approach; layout, streaming and short transcripts never page by themselves.
  const readerApproached = useRef(false);
  const loadEarlier = useCallback(() => {
    const history = store.history;
    if (!readerApproached.current) return;
    readerApproached.current = false;
    if (history?.hasMore && !history.loading && !history.error) void history.load();
  }, [store]);
  useEffect(() => {
    if (!scroller) return;
    // Scrolling up at the very top moves nothing, so the list reports no reader scroll.
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0 || scroller.scrollTop > 1) return;
      readerApproached.current = true;
      loadEarlier();
    };
    scroller.addEventListener("wheel", handleWheel, { passive: true });
    return () => scroller.removeEventListener("wheel", handleWheel);
  }, [loadEarlier, scroller]);
  // Each selection is revealed once, by its stable key. Arriving or streaming
  // messages cannot retarget it, and the selection pauses following.
  const selectedItemKey = selectedItemIndex >= 0 ? itemKeys[selectedItemIndex] : undefined;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !scroller || !messageSelection || selectedItemKey === undefined) return;
    if (revealedSelectionRevision.current === messageSelection.revision) return;
    revealedSelectionRevision.current = messageSelection.revision;
    stopFollowing();
    const index = list.getState().indexByKey(selectedItemKey);
    if (index === undefined) return;
    // The composer dock overlays the bottom of the transcript.
    const dock =
      Number.parseFloat(getComputedStyle(scroller).getPropertyValue("--composer-dock-height")) || 0;
    void list.scrollIndexIntoView({
      index,
      animated: false,
      viewportMargin: {
        start: revealMargin(list, selectedItemKey),
        end: dock + selectionRevealMargin,
      },
    });
  }, [messageSelection, scroller, selectedItemKey, stopFollowing]);
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
  // Persist the reading position for session switches. This only records.
  const anchorIds = new Map(
    rows.map((row) => [
      row.key,
      { messageId: transcriptAnchorId(row.item), key: itemKeys[row.index]! },
    ]),
  );
  const currentAnchorIds = useRef(anchorIds);
  currentAnchorIds.current = anchorIds;
  // The list reports scrolling at most once per frame.
  const recordPosition = useCallback(() => {
    const list = listRef.current;
    const position = list && captureScrollPosition(list, currentAnchorIds.current);
    if (position) store.transcriptInteraction.setTranscriptScrollPosition(position);
  }, [store]);
  const error: ChatTranscriptFooterError | undefined = errorOverride ?? store.error;
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
          submitFocusRef={annotationSubmitFocusRef}
          onAdd={(annotation) => store.addAnnotation(annotation)}
          onClose={() => setAnnotationDraft(undefined)}
        />
      )}
    </>
  );
  const renderItem = ({ item: row }: { item: TranscriptRow }) => {
    const { key, item, index, section } = row;
    if (row.kind === "section-space")
      return (
        <div
          aria-hidden
          className={section?.expanded ? "h-8" : "h-1"}
          data-slot="task-section-space"
        />
      );
    if (row.kind === "section-end")
      return <div aria-hidden className="h-px" data-slot="task-section-end" />;
    if (row.kind === "task-heading" && section?.todoId && behavior.todos)
      return (
        <div
          data-slot="task-section-header"
          data-transcript-item-index={index}
          data-transcript-section-anchor-id={transcriptAnchorId(item)}
          className="bg-background pb-3 has-[[aria-expanded=false]]:pb-0"
        >
          <div className="mx-auto w-full max-w-3xl min-w-0 [&_[data-slot=task-section-label]]:mb-0 [&_[data-slot=task-section-label]]:bg-background">
            <TaskSectionRail
              todoId={section.todoId}
              start
              headingOnly
              todos={behavior.todos}
              expanded={section.expanded}
              onToggle={() => behavior.todos?.toggleTranscriptSection(section.key, section.todoId!)}
            />
          </div>
        </div>
      );
    return (
      <FullscreenTranscriptContext value={fullscreenTranscript}>
        <ChatTranscriptItem
          itemKey={key}
          item={item}
          index={index}
          arriving={isArriving(key)}
          errorFollowsUser={errorNoticeFollowsUser(items, index)}
          selected={index === selectedItemIndex}
          behavior={item.id === latestMessageId ? latestMessageBehavior : transcriptBehavior}
          loadingStartedAt={loadingStartedAt}
          loadingLabel={loadingLabel}
          taskSection={section}
        />
      </FullscreenTranscriptContext>
    );
  };
  const historyHeader = store.history?.hasMore && (
    <div className="grid min-h-10 justify-items-center gap-2 px-6 py-2">
      <span role="status" className="text-xs text-muted-foreground" aria-live="polite">
        {store.history.loading ? "Loading earlier messages…" : "Earlier messages"}
      </span>
      {store.history.error && (
        <>
          <Callout variant="error">{store.history.error}</Callout>
          <Button
            variant="ghost"
            size="sm"
            disabled={store.history.loading}
            onClick={() => void store.history?.load()}
          >
            Retry loading earlier messages
          </Button>
        </>
      )}
    </div>
  );
  const showsList = visibleParts.length > 0 && !(focused && items.length === 0);
  return (
    <ConversationMarkdownProvider
      workspacePath={behavior.workspacePath}
      projectPath={behavior.projectPath}
      stateSessionId={behavior.messageReferenceSessionId}
    >
      {selectionOverlays}
      {showsList ? (
        <LegendList<TranscriptRow>
          ref={attachList}
          // Clicking the transcript focuses it (not the body) so its pane keeps
          // keyboard message selection and keyboard scrolling. Not a tab stop.
          tabIndex={-1}
          role="region"
          aria-label="Conversation"
          className={scrollerClassName}
          contentContainerClassName="transcript-content mx-auto w-full max-w-[75rem] min-w-0 px-6 max-[620px]:px-4 in-[.chat-layout-compact]:px-3"
          data={rows}
          // The list retains the actual header node, not a second overlay. Its
          // sticky origin is the transcript scrollport, below the workspace chrome.
          stickyHeaderIndices={stickyIndices}
          // Row inputs beyond the item (selection, behaviors, sections) change per render.
          extraData={renderItem}
          keyExtractor={(row) => row.key}
          getItemType={(row) =>
            row.kind === "message"
              ? row.item.kind === "text"
                ? row.item.role
                : row.item.kind
              : row.kind
          }
          renderItem={renderItem}
          recycleItems={false}
          estimatedItemSize={120}
          drawDistance={480}
          {...(opening.current?.atEnd === false
            ? {
                initialScrollIndex: {
                  index: opening.current.index,
                  viewOffset: opening.current.viewOffset,
                },
              }
            : { initialScrollAtEnd: true })}
          maintainScrollAtEnd={follow.maintainScrollAtEnd}
          maintainScrollAtEndThreshold={0}
          maintainVisibleContentPosition={{ data: true, size: true }}
          onUserScroll={() => {
            readerApproached.current = true;
            store.transcriptInteraction.cancelResultReveal();
          }}
          onStartReached={loadEarlier}
          onScroll={recordPosition}
          onItemSizeChanged={follow.update}
          ListHeaderComponent={
            <>
              {historyHeader}
              <div
                aria-hidden
                className="h-[42px] in-[.chat-layout-compact]:h-5"
                data-slot="transcript-top-space"
              />
            </>
          }
          ListFooterComponent={<ChatTranscriptFooter footer={footer} error={error} />}
        />
      ) : (
        <div ref={setScroller} tabIndex={-1} className={scrollerClassName}>
          {historyHeader}
          <Conversation className="px-6 pt-[42px] pb-[210px] max-[620px]:px-4">
            {focused ? (
              <p role="status" className="text-sm text-muted-foreground">
                {history?.hasMore || history?.loading ? null : "No messages tagged to this to-do."}
              </p>
            ) : (
              empty
            )}
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
        </div>
      )}
    </ConversationMarkdownProvider>
  );
});
