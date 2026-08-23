import { useEffect, useRef } from "react";
import { observer } from "r-state-tree/react";
import {
  VirtualizedConversation,
  type VirtualizedConversationHandle,
} from "@/components/ai-elements/conversation";
import type { ChangedFile } from "../../ipc/session-contract";
import type { ChangesStore } from "../stores/ChangesStore";
import type { ReviewsStore } from "../stores/ReviewsStore";
import { HighlightedDiff } from "./highlighted-diff";

export const FullDiff = observer(function FullDiff({
  changes,
  reviews,
  store,
  reviewable = true,
  scrollRequest,
}: {
  changes: readonly ChangedFile[];
  reviews: ReviewsStore;
  store: ChangesStore;
  reviewable?: boolean;
  scrollRequest?: { path: string; revision: number };
}) {
  const virtuosoRef = useRef<VirtualizedConversationHandle>(null);
  const activePathRef = useRef<string | undefined>(store.selected?.path);
  const changeKey = changes.map((change) => change.path).join("\u0000");

  useEffect(() => {
    activePathRef.current = store.selected?.path;
  }, [changeKey, store]);

  useEffect(() => {
    if (!scrollRequest) return;
    const index = changes.findIndex((change) => change.path === scrollRequest.path);
    if (index < 0) return;
    activePathRef.current = changes[index]?.path;
    virtuosoRef.current?.scrollToIndex({ index, align: "start" });
  }, [changes, scrollRequest]);

  const selectVisibleChange = (index: number) => {
    const path = changes[index]?.path;
    if (!path || path === activePathRef.current) return;
    activePathRef.current = path;
    store.select(path);
  };

  return (
    <VirtualizedConversation
      ref={virtuosoRef}
      className="change-explorer-diff change-explorer-all-diff"
      role="region"
      aria-label={`All workspace changes · ${changes.length} files`}
      data={changes}
      computeItemKey={(_index, item) => item.path}
      rangeChanged={({ startIndex }) => selectVisibleChange(startIndex)}
      atBottomStateChange={(atBottom) => {
        if (atBottom) selectVisibleChange(changes.length - 1);
      }}
      itemContent={(index, item) => (
        <section
          className={`change-explorer-file-section${index > 0 ? " has-divider" : ""}`}
          data-change-path={item.path}
          aria-label={`Changes to ${item.path}`}
        >
          <header className="change-explorer-diff-file-header">
            <strong title={item.previousPath ? `${item.previousPath} → ${item.path}` : item.path}>
              {item.previousPath ? `${item.previousPath} → ${item.path}` : item.path}
            </strong>
            <span>
              <b>+{item.additions}</b>
              <i>−{item.deletions}</i>
            </span>
          </header>
          <HighlightedDiff
            change={item}
            reviews={reviews}
            store={store}
            reviewable={reviewable}
            className="change-explorer-embedded-diff"
          />
        </section>
      )}
    />
  );
});
