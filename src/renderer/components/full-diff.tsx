import { useEffect, useRef } from "react";
import { observer } from "r-state-tree/react";
import type { ChangedFile } from "../../ipc/session-contract";
import type { ChangesStore } from "../stores/ChangesStore";
import type { ReviewsStore } from "../stores/ReviewsStore";
import { HighlightedDiff } from "./highlighted-diff";

function changeSection(container: HTMLElement, path: string) {
  return [...container.querySelectorAll<HTMLElement>("[data-change-path]")].find(
    (element) => element.dataset.changePath === path,
  );
}
function scrollToChange(container: HTMLElement | null, path: string) {
  if (container) changeSection(container, path)?.scrollIntoView?.({ block: "start" });
}
function activeChangePath(container: HTMLElement) {
  const sections = [...container.querySelectorAll<HTMLElement>("[data-change-path]")];
  if (
    container.scrollHeight > container.clientHeight + 2 &&
    container.scrollTop + container.clientHeight >= container.scrollHeight - 2
  )
    return sections.at(-1)?.dataset.changePath;
  const boundary = container.getBoundingClientRect().top + 24;
  let active = sections[0];
  for (const section of sections)
    if (section.getBoundingClientRect().top <= boundary) active = section;
  return active?.dataset.changePath;
}

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const activePathRef = useRef<string | undefined>(undefined);
  const changeKey = changes.map((change) => change.path).join("\u0000");
  useEffect(() => {
    if (scrollRequest) scrollToChange(scrollRef.current, scrollRequest.path);
  }, [scrollRequest]);
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const onScroll = () => {
      const path = activeChangePath(container);
      if (!path || path === activePathRef.current) return;
      activePathRef.current = path;
      store.select(path);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [changeKey, store]);
  return (
    <div
      ref={scrollRef}
      className="change-explorer-diff change-explorer-all-diff"
      role="region"
      aria-label={`All workspace changes · ${changes.length} files`}
    >
      {changes.map((item) => (
        <section
          className="change-explorer-file-section"
          data-change-path={item.path}
          aria-label={`Changes to ${item.path}`}
          key={item.path}
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
      ))}
    </div>
  );
});
