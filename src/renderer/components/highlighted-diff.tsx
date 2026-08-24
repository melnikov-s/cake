import { Fragment, useEffect, useMemo, useState } from "react";
import { observer } from "r-state-tree/react";
import type { ChangedFile } from "../../ipc/session-contract";
import type { ReviewAnchor, ReviewPoint } from "../../ipc/review-contract";
import { parseDiff } from "./ai-elements/diff-view";
import { syntaxTokenStyle, useHighlightedSource } from "./ai-elements/code";
import { IconButton } from "./ui/icon-button";
import { AddCommentIcon } from "./ui/icons";
import type { ChangesStore } from "../stores/ChangesStore";
import type { ReviewsStore } from "../stores/ReviewsStore";
import { ReviewDraftCard } from "./review-draft-card";
import { ReviewThreadCard } from "./review-thread-card";
import { extractSourceSelection } from "./source-selection";

function reviewPoint(
  lines: ReturnType<typeof parseDiff>,
  index: number,
  column?: number,
): ReviewPoint {
  const line = lines[index]!;
  return { diffLine: index, oldLine: line.oldNumber, newLine: line.newNumber, column };
}

function reviewAnchor(
  change: ChangedFile,
  lines: ReturnType<typeof parseDiff>,
  startIndex: number,
  endIndex: number,
  selectedText: string,
  startColumn?: number,
  endColumn?: number,
): ReviewAnchor {
  const content = (line: (typeof lines)[number]) => line.content;
  return {
    path: change.path,
    start: reviewPoint(lines, startIndex, startColumn),
    end: reviewPoint(lines, endIndex, endColumn),
    selectedText,
    contextBefore: lines
      .slice(Math.max(0, startIndex - 3), startIndex)
      .map(content)
      .join("\n"),
    contextAfter: lines
      .slice(endIndex + 1, endIndex + 4)
      .map(content)
      .join("\n"),
    diff: change.diff,
  };
}

export const HighlightedDiff = observer(function HighlightedDiff({
  change,
  reviews,
  store,
  reviewable = true,
  className = "",
}: {
  change: ChangedFile;
  reviews: ReviewsStore;
  store: ChangesStore;
  reviewable?: boolean;
  className?: string;
}) {
  const lines = useMemo(() => parseDiff(change.diff), [change.diff]);
  const source = useMemo(
    () => lines.map((line) => (line.kind === "meta" ? "" : line.content)).join("\n"),
    [lines],
  );
  const tokens = useHighlightedSource(change.path, source);
  const [composer, setComposer] = useState<{ anchor: ReviewAnchor }>();
  const threads = reviewable
    ? reviews.threads.filter(
        (thread) =>
          thread.anchor.view !== "file" &&
          thread.anchor.view !== "full" &&
          thread.anchor.view !== "message" &&
          store.changeMatchesPath(change, thread.anchor.path),
      )
    : [];
  useEffect(() => () => reviews.cancelDraft(), [change.path, reviews]);
  const openComposer = (anchor: ReviewAnchor) => {
    reviews.prepareDraft(anchor);
    setComposer({ anchor });
  };
  const cancelComposer = () => {
    reviews.cancelDraft();
    setComposer(undefined);
  };
  const openFromLineAction = (button: HTMLButtonElement, index: number, line: string) => {
    const container = button.closest<HTMLElement>('[role="table"]');
    const selected =
      container &&
      extractSourceSelection(
        container,
        ".change-explorer-line[data-diff-index]",
        "data-diff-index",
      );
    openComposer(
      selected && selected.selectedText
        ? reviewAnchor(
            change,
            lines,
            selected.startIndex,
            selected.endIndex,
            selected.selectedText,
            selected.startColumn,
            selected.endColumn,
          )
        : reviewAnchor(change, lines, index, index, line, 0, line.length),
    );
  };
  return (
    <div
      className={`change-explorer-diff ${className}`.trim()}
      role="table"
      aria-label={`Changes to ${change.path}`}
    >
      {lines.map((line, index) =>
        line.kind === "meta" ? (
          <div className="change-explorer-line meta" role="row" key={line.key}>
            <span />
            <span />
            <code>{line.content}</code>
          </div>
        ) : (
          <Fragment key={line.key}>
            <div className={`change-explorer-line ${line.kind}`} data-diff-index={index} role="row">
              <span className={reviewable ? "review-gutter" : undefined}>
                {reviewable && (
                  <IconButton
                    tooltip={`Comment on line ${line.newNumber ?? line.oldNumber}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) =>
                      openFromLineAction(event.currentTarget, index, line.content)
                    }
                  >
                    <AddCommentIcon />
                  </IconButton>
                )}
                {line.oldNumber}
              </span>
              <span>{line.newNumber}</span>
              <code>
                <b data-review-prefix>
                  {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
                </b>
                {(tokens?.[index] ?? []).length > 0
                  ? tokens![index]!.map((token, tokenIndex) => (
                      <i
                        className="syntax-token"
                        style={syntaxTokenStyle(token)}
                        key={`${tokenIndex}-${token.content}`}
                      >
                        {token.content}
                      </i>
                    ))
                  : line.content || " "}
              </code>
            </div>
            {composer && composer.anchor.end.diffLine === index && (
              <ReviewDraftCard anchor={composer.anchor} store={reviews} onCancel={cancelComposer} />
            )}
            {threads
              .filter((thread) => thread.anchor.end.diffLine === index)
              .map((thread) => (
                <ReviewThreadCard
                  key={`${thread.id}:${thread.status}`}
                  thread={thread}
                  store={reviews}
                />
              ))}
          </Fragment>
        ),
      )}
    </div>
  );
});
