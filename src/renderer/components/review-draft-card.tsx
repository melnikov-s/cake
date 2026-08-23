import { observer } from "r-state-tree/react";
import type { ReviewAnchor } from "../../ipc/review-contract";
import type { ReviewsStore } from "../stores/ReviewsStore";
import { Chat } from "./chat";

export const ReviewDraftCard = observer(function ReviewDraftCard({
  anchor,
  store,
  onCancel,
}: {
  anchor: ReviewAnchor;
  store: ReviewsStore;
  onCancel(): void;
}) {
  if (store.draftAnchor !== anchor) return null;
  const cancel = () => {
    store.cancelDraft();
    onCancel();
    window.getSelection()?.removeAllRanges();
  };
  return (
    <article
      className="review-thread review-thread-draft"
      aria-label={`New code chat on ${anchor.path}`}
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}
    >
      <header>
        <span>
          <i />
          New code chat
        </span>
        <div>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      </header>
      <Chat store={store.draftChatStore} embedded compact />
    </article>
  );
});
