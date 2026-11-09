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
import {
  Conversation,
  VirtualizedConversation,
  type VirtualizedConversationHandle,
} from "@/components/ai-elements/conversation";
import { AnnotationDraftPopover } from "@/components/annotation-draft-popover";
import { ChatTranscriptFooter, type ChatTranscriptFooterContext } from "./chat-transcript-footer";
import { ConversationMarkdownProvider } from "./conversation-markdown-provider";
import { FullscreenTranscriptContext } from "./fullscreen-transcript-context";
import { TranscriptScroller } from "./transcript-scroller";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { LoadingState } from "@/components/ui/loading-state";
import { SideChatContext } from "@/components/side-chat-context";
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
import { transcriptItemParts, type TranscriptContentPart } from "./chat-transcript-items";
import { ChatTranscriptItem } from "./chat-transcript-item";
import { transcriptItemKeys } from "./chat-transcript-items";
import { transcriptTaskSections } from "../lib/transcript-task-sections";
import { todoMessageMatches } from "../lib/todo-message-matches";
import { resultTodoOrigin, referenceTodoOrigin } from "../lib/result-todo-origin";
import {
  isCakeChatSessionId,
  isProjectChatSessionId,
  cakeChatSideChatParentId,
} from "../../contracts/cake-chats/cake-chat-identity";
import { useArrivals } from "../hooks/use-arrivals";
import {
  createTranscriptScrollOwner,
  type TranscriptScrollOwner,
} from "../lib/transcript-scroll-owner";

export {
  captureMessageSelection,
  type ChatTranscriptBehavior,
  type TranscriptSelectionCapture,
} from "./chat-transcript-parts";

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
  annotationSubmitFocusRef,
}: {
  store: ChatStore;
  behavior?: ChatTranscriptBehavior;
  empty?: ReactNode;
  footer?: ReactNode;
  error?: { message: string; details?: string; title?: string };
  virtualized?: boolean;
  annotationSubmitFocusRef?: RefObject<HTMLElement | null>;
}) {
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
  const virtuosoRef = useRef<VirtualizedConversationHandle>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const renderedItemKeys = useRef<string[]>([]);
  const scrollToItem = useCallback((key: string) => {
    const index = renderedItemKeys.current.indexOf(key);
    if (index >= 0) virtuosoRef.current?.scrollToIndex({ index, align: "start", behavior: "auto" });
  }, []);
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
      restore: restoredScrollPosition?.kind === "message" ? restoredScrollPosition : undefined,
      cancelVirtualNavigation: () => virtuosoRef.current?.cancelScrollToIndex(),
      scrollToItem,
      itemIndex: (key) => renderedItemKeys.current.indexOf(key),
      loadEarlier: (beforePrepend) => {
        const history = store.history;
        if (!history?.hasMore || history.loading || history.error) return false;
        void history.load(() => {
          if (scrollOwner.current === owner) beforePrepend();
        });
        return true;
      },
    });
    scrollOwner.current = owner;
    return () => {
      owner.dispose();
      scrollOwner.current = undefined;
    };
  }, [initiallyFollowing, restoredScrollPosition, scroller, scrollToItem, store]);
  // Sending a message (from any composer path) is the only time the transcript
  // scrolls to the bottom for the reader.
  const sentMessageRevision = store.transcriptInteraction.sentMessageRevision;
  const scrolledForSentMessage = useRef(sentMessageRevision);
  const supportsTodoFocus = Boolean(
    (isCakeChatSessionId(store.id) || cakeChatSideChatParentId(store.id)) && behavior.todos,
  );
  const focusedTodos = supportsTodoFocus ? (behavior.todos?.focusedItems ?? []) : [];
  const focused = focusedTodos.length > 0;
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
  const reconcileScroll = useCallback(() => {
    // Runs at the virtual range's layout boundary, before scroll reconciliation.
    renderedItemKeys.current = itemKeys;
    scrollOwner.current?.reconcile();
  }, [itemKeys]);
  useLayoutEffect(reconcileScroll);
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
  // Loading rows can disappear during submission. Use the last
  // content row as the durable destination while the virtual range settles.
  const lastItemKey =
    allItemKeys[visibleIndices.findLast((index) => index < visibleGroupedParts.length) ?? -1];
  useLayoutEffect(() => {
    const owner = scrollOwner.current;
    if (!owner || scrolledForSentMessage.current === sentMessageRevision) return;
    if (virtualized && lastItemKey !== undefined && !virtuosoRef.current) return;
    scrolledForSentMessage.current = sentMessageRevision;
    // Side chat may follow this send, but its covered transcript must keep
    // the row that owns fullscreen mounted.
    if (presentedFullscreens) return;
    owner.scrollToBottomForSentMessage(
      virtualized && lastItemKey !== undefined
        ? {
            itemKey: lastItemKey,
            scrollToIndex: () =>
              virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" }),
          }
        : undefined,
    );
  }, [lastItemKey, scroller, sentMessageRevision, virtualized, presentedFullscreens]);
  const resultItemIndex = resultPartId
    ? items.findIndex((item) => transcriptItemParts(item).some((part) => part.id === resultPartId))
    : -1;
  const resultItemKey = resultItemIndex < 0 ? undefined : itemKeys[resultItemIndex];
  useLayoutEffect(() => {
    const owner = scrollOwner.current;
    if (!owner) return;
    if (!resultReveal) {
      owner.cancelResultReveal();
      return;
    }
    if (virtualized && resultItemKey !== undefined && !virtuosoRef.current) return;
    owner.revealResult(
      resultItemKey,
      () => {
        if (resultItemKey !== undefined) scrollToItem(resultItemKey);
      },
      () => store.transcriptInteraction.cancelResultReveal(resultReveal.revision),
    );
  }, [resultReveal, resultItemKey, scroller, scrollToItem, store, virtualized]);
  // Exact originals or an already-bound explanation can leave the current
  // history page. Page only for explicit navigation, stopping on resolution/cancel.
  const history = store.history;
  const historyLoading = history?.loading;
  const historyHasMore = history?.hasMore;
  const historyError = history?.error;
  useEffect(() => {
    if (
      !(resultReveal?.partIds?.length || resultReveal?.messageId) ||
      resultPartId ||
      !historyHasMore ||
      historyLoading ||
      historyError
    )
      return;
    void history?.load();
  }, [resultReveal, resultPartId, history, historyLoading, historyHasMore, historyError]);
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
  const restoredMessageItemIndex =
    restoredScrollPosition?.kind === "message"
      ? items.findIndex((item) =>
          transcriptItemParts(item).some((part) => part.id === restoredScrollPosition.messageId),
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
  useLayoutEffect(
    () => scrollOwner.current?.setSelecting(selecting || presentedFullscreens > 0),
    [scroller, selecting, presentedFullscreens],
  );
  useLayoutEffect(
    () => scrollOwner.current?.setCovered(presentedFullscreens > 0),
    [scroller, presentedFullscreens],
  );
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
  const error: ChatTranscriptFooterContext["error"] = errorOverride ?? store.error;
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
  const renderItem = (item: TranscriptItem, index: number) => (
    <FullscreenTranscriptContext key={itemKeys[index]} value={fullscreenTranscript}>
      <ChatTranscriptItem
        itemKey={itemKeys[index] ?? item.id}
        item={item}
        index={index}
        arriving={isArriving(itemKeys[index] ?? item.id)}
        errorFollowsUser={errorNoticeFollowsUser(items, index)}
        selected={index === selectedItemIndex}
        behavior={item.id === latestMessageId ? latestMessageBehavior : transcriptBehavior}
        loadingStartedAt={loadingStartedAt}
        loadingLabel={loadingLabel}
        taskSection={visibleSectionViews[index]}
      />
    </FullscreenTranscriptContext>
  );
  return (
    <ConversationMarkdownProvider
      workspacePath={behavior.workspacePath}
      stateSessionId={behavior.messageReferenceSessionId}
    >
      {selectionOverlays}
      <div
        ref={setScroller}
        // Clicking the transcript focuses it (not the body) so its pane keeps
        // keyboard message selection and keyboard scrolling. Not a tab stop.
        tabIndex={-1}
        className="transcript @container/transcript outline-none h-full w-full max-w-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable_both-edges] [overflow-anchor:none]"
      >
        <div ref={contentRef} className="min-w-0">
          {store.history?.hasMore && (
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
                    onClick={() => {
                      const owner = scrollOwner.current;
                      void store.history?.load(() => {
                        if (owner && scrollOwner.current === owner)
                          owner.preserveForPrepend(scrollToItem);
                      });
                    }}
                  >
                    Retry loading earlier messages
                  </Button>
                </>
              )}
            </div>
          )}
          {visibleParts.length === 0 || (focused && items.length === 0) ? (
            <Conversation className="px-6 pt-[42px] pb-[210px] max-[620px]:px-4">
              {focused ? (
                <p role="status" className="text-sm text-muted-foreground">
                  No messages tagged to this to-do.
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
    </ConversationMarkdownProvider>
  );
});
