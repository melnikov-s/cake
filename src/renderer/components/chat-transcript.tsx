import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { observer } from "r-state-tree/react";
import { cn } from "@/lib/utils";
import {
  Conversation,
  VirtualizedConversation,
  type VirtualizedConversationHandle,
} from "@/components/ai-elements/conversation";
import { AnnotationDraftPopover } from "@/components/annotation-draft-popover";
import { ChangedFiles } from "@/components/changed-files";
import { LoadingState } from "@/components/ui/loading-state";
import {
  MessageCommentDraftPopover,
  type MessageCommentAnchorRect,
} from "@/components/message-comment-popover";
import { workLogChanges } from "../../utils/turn-diff";
import type { BottomFollowController } from "../lib/bottom-follow-controller";
import type { ChatStore } from "../stores/ChatStore";
import {
  ActivityGroup,
  ErrorNotice,
  ReviewRunMessage,
  TranscriptList,
  TranscriptPart,
  captureTranscriptSelection,
  chatWorkIsActive,
  errorNoticeFollowsUser,
  groupTranscriptParts,
  type CanonicalTranscriptBehavior,
  type ChatTranscriptBehavior,
  type TranscriptItem,
  type TranscriptSelectionCapture,
} from "./chat-transcript-parts";

export {
  captureMessageSelection,
  chatWorkIsActive,
  groupTranscriptParts,
  type ChatTranscriptBehavior,
  type TranscriptSelectionCapture,
} from "./chat-transcript-parts";

export const ChatTranscript = observer(function ChatTranscript({
  store,
  behavior = {},
  empty,
  footer,
  error: errorOverride,
  virtualized = true,
  scrollController,
  renderChat,
}: {
  store: ChatStore;
  behavior?: ChatTranscriptBehavior;
  empty?: ReactNode;
  footer?: ReactNode;
  error?: { message: string; details?: string; title?: string };
  virtualized?: boolean;
  scrollController: BottomFollowController;
  renderChat(store: ChatStore): ReactNode;
}) {
  const virtuosoRef = useRef<VirtualizedConversationHandle>(null);
  const virtualScrollerRef = useRef<HTMLElement | null>(null);
  const staticTranscriptRef = useRef<HTMLDivElement>(null);
  const pendingSelectionRef = useRef<TranscriptSelectionCapture | undefined>(undefined);
  const restoredScrollState = useMemo(() => store.transcriptScrollState, [store]);
  const [draftAnchor, setDraftAnchor] = useState<MessageCommentAnchorRect>();
  const [annotationDraft, setAnnotationDraft] = useState<TranscriptSelectionCapture>();
  // Render is the last point at which the mounted transcript still has its
  // pre-commit geometry. Parent updates (for example, another session settling)
  // must not turn an asynchronously restored position back into bottom-following.
  scrollController.capturePositionBeforeLayout();
  const visibleParts = store.hideThinking
    ? store.parts.filter((part) => part.kind !== "reasoning")
    : store.parts;
  const showAssistantLoading = chatWorkIsActive(
    store.parts,
    store.streaming,
    store.submitting,
    Boolean(behavior.waitingForUser || behavior.artifacts?.interaction.request),
  );
  useLayoutEffect(() => {
    store.syncChangedFilesOpen(showAssistantLoading);
  }, [showAssistantLoading, store]);
  const groupedParts = groupTranscriptParts(store.parts);
  const visibleGroupedParts = store.hideThinking
    ? groupedParts.flatMap((item): TranscriptItem[] => {
        if (item.kind === "reasoning") return [];
        if (item.kind !== "activity-group") return [item];
        const parts = item.parts.filter((part) => part.kind !== "reasoning");
        return parts.length > 0 ? [{ ...item, parts }] : [];
      })
    : groupedParts;
  const items: TranscriptItem[] = [
    ...visibleGroupedParts,
    ...(workLogChanges(store.parts).length > 0
      ? [{ kind: "changed-files" as const, id: "changed-files" }]
      : []),
    ...(showAssistantLoading ? [{ kind: "loading-state" as const, id: "loading-state" }] : []),
  ];
  const itemCountRef = useRef(items.length);
  itemCountRef.current = items.length;
  const transcriptBehavior: CanonicalTranscriptBehavior = {
    store,
    ...behavior,
    renderChat,
  };
  const scrollToLatest = useCallback(() => {
    if (itemCountRef.current > 0)
      virtuosoRef.current?.scrollToIndex({
        index: itemCountRef.current - 1,
        align: "end",
        behavior: "auto",
      });
    if (staticTranscriptRef.current)
      staticTranscriptRef.current.scrollTop = staticTranscriptRef.current.scrollHeight;
  }, []);
  const setStaticScroller = useCallback(
    (scroller: HTMLDivElement | null) => {
      staticTranscriptRef.current = scroller;
      scrollController.connectScroller(scroller ?? undefined);
    },
    [scrollController],
  );
  useLayoutEffect(() => {
    scrollController.setAlignBottom(scrollToLatest);
    if (restoredScrollState === undefined) scrollController.layoutChanged();
    else scrollController.changePosition(() => undefined);
    return () => scrollController.setAlignBottom(undefined);
  }, [restoredScrollState, scrollController, scrollToLatest]);
  useLayoutEffect(() => scrollController.layoutChanged());
  const messageNavigationRequest = store.messageNavigationRequest;
  const messageNavigationItemIndex = messageNavigationRequest
    ? items.findIndex((item) =>
        item.kind === "activity-group" || item.kind === "source-group"
          ? item.parts.some((part) => part.id === messageNavigationRequest.messageId)
          : item.id === messageNavigationRequest.messageId,
      )
    : -1;
  const hasOpeningScrollTarget =
    restoredScrollState !== undefined || messageNavigationItemIndex >= 0;
  useLayoutEffect(() => {
    if (!messageNavigationRequest || messageNavigationItemIndex < 0) return;
    scrollController.changePosition(() => {
      virtuosoRef.current?.scrollToIndex({
        index: messageNavigationItemIndex,
        align: "center",
        behavior: "auto",
      });
      staticTranscriptRef.current
        ?.querySelector<HTMLElement>(`[data-transcript-item-index="${messageNavigationItemIndex}"]`)
        ?.scrollIntoView({ block: "center" });
    });
  }, [messageNavigationItemIndex, messageNavigationRequest, scrollController]);
  const setVirtualScroller = useCallback(
    (scroller: HTMLElement | null | Window) => {
      virtualScrollerRef.current = scroller instanceof HTMLElement ? scroller : null;
      scrollController.connectScroller(virtualScrollerRef.current ?? undefined);
    },
    [scrollController],
  );
  useEffect(() => {
    const scroller = virtualScrollerRef.current ?? staticTranscriptRef.current;
    if (!scroller) return;
    let pendingScrollState = store.transcriptScrollState;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const commitScrollState = () => {
      saveTimer = undefined;
      if (pendingScrollState) store.setTranscriptScrollState(pendingScrollState);
    };
    const captureScrollState = () => {
      virtuosoRef.current?.getState((state) => {
        pendingScrollState = state;
        if (saveTimer !== undefined) clearTimeout(saveTimer);
        saveTimer = setTimeout(commitScrollState, 100);
      });
    };
    scroller.addEventListener("scroll", captureScrollState, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", captureScrollState);
      if (saveTimer !== undefined) clearTimeout(saveTimer);
      if (pendingScrollState) store.setTranscriptScrollState(pendingScrollState);
    };
  }, [store, virtualized]);
  const error = errorOverride ?? store.error;
  // Right-clicking any selection inside this conversation keeps the native
  // Electron edit menu. The capture is held until that menu sends its
  // "Chat about this" action back to this transcript.
  const messageComments = behavior.messageComments;
  const openSelectionDraft = useCallback(
    (capture: TranscriptSelectionCapture) => {
      if (!messageComments) return;
      messageComments.prepareDraft(capture.selection);
      pendingSelectionRef.current = undefined;
      setDraftAnchor(capture.rect);
    },
    [messageComments],
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
        canChat: Boolean(messageComments),
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
  }, [behavior.showSelectionContextMenu, messageComments, openSelectionDraft, store]);
  const changedFiles = (
    <ChangedFiles
      parts={store.parts}
      workspacePath={behavior.workspacePath}
      open={store.changedFilesOpen}
      onOpenChange={(open) => store.setChangedFilesOpen(open)}
      onOpenFile={
        behavior.openSourceLocation
          ? (path) => behavior.openSourceLocation?.({ path, view: "changes" })
          : undefined
      }
    />
  );
  const selectionOverlays = (
    <>
      {draftAnchor && messageComments && (
        <MessageCommentDraftPopover
          anchor={draftAnchor}
          chatStore={messageComments.draftChatStore}
          renderChat={renderChat}
          onClose={() => setDraftAnchor(undefined)}
        />
      )}
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
    <div
      key={item.id}
      data-slot="transcript-item"
      data-transcript-item-index={index}
      className={cn(
        "min-w-0 pb-5 in-[.chat-layout-compact]:pb-3.5",
        errorNoticeFollowsUser(items, index) && "pt-3",
      )}
    >
      {item.kind === "activity-group" ? (
        <ActivityGroup groupId={item.id} parts={item.parts} behavior={transcriptBehavior} />
      ) : item.kind === "source-group" ? (
        <div className="flex flex-wrap items-center gap-2" data-slot="source-group">
          {item.parts.map((part) => (
            <TranscriptPart key={part.id} part={part} behavior={transcriptBehavior} />
          ))}
        </div>
      ) : item.kind === "changed-files" ? (
        changedFiles
      ) : item.kind === "loading-state" ? (
        <LoadingState startedAt={store.loadingStartedAt} />
      ) : item.kind === "review-run" ? (
        <ReviewRunMessage run={item} onOpen={transcriptBehavior.onOpenReviewRun} />
      ) : (
        <TranscriptPart part={item} behavior={transcriptBehavior} />
      )}
    </div>
  );
  if (visibleParts.length === 0)
    return (
      <>
        {selectionOverlays}
        <div
          ref={setStaticScroller}
          className="transcript h-full w-full max-w-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto px-6 pt-[42px] pb-[210px] [scrollbar-gutter:stable_both-edges] max-[620px]:px-4"
        >
          <Conversation>
            {empty}
            {showAssistantLoading && <LoadingState startedAt={store.loadingStartedAt} />}
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
      </>
    );
  if (!virtualized)
    return (
      <>
        {selectionOverlays}
        <div
          ref={setStaticScroller}
          className="transcript h-full w-full max-w-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable_both-edges]"
        >
          <TranscriptList>
            {items.map(renderItem)}
            <div className="mx-auto w-full max-w-[51rem] px-6 pb-[var(--composer-dock-height,210px)] max-[620px]:px-4 in-[.chat-layout-compact]:px-3 in-[.chat-layout-compact]:pb-2 in-[.chat-layout-compact]:min-h-0">
              {footer}
              {error?.message && (
                <ErrorNotice
                  title={error.title ?? "Operation failed"}
                  message={error.message}
                  details={error.details}
                />
              )}
            </div>
          </TranscriptList>
        </div>
      </>
    );
  return (
    <>
      {selectionOverlays}
      <VirtualizedConversation
        key={store.id}
        ref={virtuosoRef}
        className="transcript h-full w-full max-w-full min-h-0 min-w-0 overflow-x-hidden [scrollbar-gutter:stable_both-edges] [overflow-anchor:none]"
        data={items}
        computeItemKey={(_index, item) => item.id}
        initialTopMostItemIndex={
          hasOpeningScrollTarget ? undefined : { index: items.length - 1, align: "end" }
        }
        restoreStateFrom={restoredScrollState}
        followOutput={false}
        scrollerRef={setVirtualScroller}
        components={{
          List: TranscriptList,
          Footer: () => (
            <div className="mx-auto w-full max-w-[51rem] px-6 pb-[var(--composer-dock-height,210px)] max-[620px]:px-4 in-[.chat-layout-compact]:px-3 in-[.chat-layout-compact]:pb-2 in-[.chat-layout-compact]:min-h-0">
              {footer}
              {error?.message && (
                <ErrorNotice
                  title={error.title ?? "Operation failed"}
                  message={error.message}
                  details={error.details}
                />
              )}
            </div>
          ),
        }}
        itemContent={(index, item) => renderItem(item, index)}
      />
    </>
  );
});
