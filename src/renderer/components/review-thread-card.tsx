import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { ReviewThread } from "../../models/ReviewThread";
import type { ReviewsStore } from "../stores/ReviewsStore";
import { Chat } from "./chat";

export const ReviewThreadCard = observer(function ReviewThreadCard({
  thread,
  store,
  onFocus,
}: {
  thread: ReviewThread;
  store: ReviewsStore;
  onFocus?: () => void;
}) {
  const [expanded, setExpanded] = useState(thread.status === "open");
  const chat = store.chatStore(thread.id);
  const focus = () => (onFocus ? onFocus() : store.selectThread(thread.id));
  if (!expanded)
    return (
      <button
        className={`review-thread-collapsed ${thread.status} ${store.activeThread?.id === thread.id ? "active" : ""}`}
        aria-label="Expand review thread"
        data-review-thread-id={thread.id}
        onClick={() => {
          focus();
          setExpanded(true);
        }}
      >
        {thread.status === "resolved" ? "✓ Resolved thread" : "Review thread"} ·{" "}
        {thread.messageCount} messages
      </button>
    );
  return (
    <article
      className={`review-thread ${thread.status} ${store.activeThread?.id === thread.id ? "active" : ""}`}
      data-review-thread-id={thread.id}
      aria-label={`Review thread on ${thread.anchor.path}`}
      onClick={focus}
    >
      <header>
        <button
          type="button"
          className="review-thread-header-toggle"
          aria-label="Collapse review thread"
          onClick={() => {
            focus();
            setExpanded(false);
          }}
        >
          <span>
            <i />
            {thread.status === "resolved"
              ? "Resolved"
              : store.threadStreaming(thread.id)
                ? "Working"
                : thread.pending
                  ? "Pending review"
                  : "Review thread"}
          </span>
        </button>
        <div onClick={(event) => event.stopPropagation()}>
          {thread.status === "resolved" ? (
            <button onClick={() => void store.resolveThread(thread.id, false)}>Reopen</button>
          ) : (
            <button
              onClick={() => {
                setExpanded(false);
                void store.resolveThread(thread.id);
              }}
            >
              Resolve
            </button>
          )}
        </div>
      </header>
      {chat && <Chat store={chat} embedded compact />}
    </article>
  );
});
