import { useMemo } from "react";
import { observer } from "r-state-tree/react";
import type { ChangedFile } from "../../ipc/session-contract";
import type { BrowseStore } from "../stores/BrowseStore";
import type { ChangesStore } from "../stores/ChangesStore";
import type { ReviewsStore } from "../stores/ReviewsStore";
import { parseDiff } from "./ai-elements/diff-view";
import { SourceReview, useFileContent } from "./source-review";
import { LoadingState } from "./ui/loading-state";

// Observer-wrapped: reads ReviewsStore.threads directly, so newly arriving
// review threads re-render the full-file view without relying on a parent read.
export const FullFile = observer(function FullFile({
  change,
  reviews,
  browse,
  store,
}: {
  change: ChangedFile;
  reviews: ReviewsStore;
  browse: BrowseStore;
  store: ChangesStore;
}) {
  const readFile = useMemo(() => (path: string) => browse.readFile(path), [browse]);
  const content = useFileContent(change.path, readFile);
  if (content.error)
    return (
      <div className="change-explorer-file-state" role="alert">
        <strong>Unable to show the full file</strong>
        <span>{content.error}</span>
      </div>
    );
  if (content.source === undefined)
    return (
      <div className="change-explorer-file-state">
        <LoadingState label="Loading full file" />
      </div>
    );
  const sourceLines = content.source.split("\n");
  const threads = reviews.threads.filter(
    (thread) =>
      thread.anchor.view === "full" && store.changeMatchesPath(change, thread.anchor.path),
  );
  const diffLines = parseDiff(change.diff);
  const addedLines = new Set(
    diffLines
      .filter((line) => line.kind === "add" && line.newNumber !== undefined)
      .map((line) => line.newNumber!),
  );
  const removalsBefore = new Map<number, typeof diffLines>();
  diffLines.forEach((line, index) => {
    if (line.kind !== "remove") return;
    let insertionLine: number | undefined;
    for (
      let nextIndex = index + 1;
      nextIndex < diffLines.length && diffLines[nextIndex]!.kind !== "meta";
      nextIndex++
    ) {
      if (diffLines[nextIndex]!.newNumber !== undefined) {
        insertionLine = diffLines[nextIndex]!.newNumber;
        break;
      }
    }
    if (insertionLine === undefined) {
      for (
        let previousIndex = index - 1;
        previousIndex >= 0 && diffLines[previousIndex]!.kind !== "meta";
        previousIndex--
      ) {
        if (diffLines[previousIndex]!.newNumber !== undefined) {
          insertionLine = diffLines[previousIndex]!.newNumber! + 1;
          break;
        }
      }
    }
    insertionLine ??= 1;
    const removals = removalsBefore.get(insertionLine) ?? [];
    removals.push(line);
    removalsBefore.set(insertionLine, removals);
  });
  const removedRows = (lineNumber: number) =>
    (removalsBefore.get(lineNumber) ?? []).map((line) => (
      <div className="change-explorer-line remove" role="row" key={`remove-${line.key}`}>
        <span>{line.oldNumber}</span>
        <code>
          <b>−</b>
          {line.content || " "}
        </code>
      </div>
    ));
  return (
    <SourceReview
      path={change.path}
      view="full"
      lines={sourceLines}
      tokens={content.tokens}
      diff={change.diff}
      reviews={reviews}
      threads={threads}
      ariaLabel={`Full file ${change.path}`}
      lineClass={(_line, index) => (addedLines.has(index + 1) ? "add" : "context")}
      prefix={(_line, index) => (addedLines.has(index + 1) ? "+" : " ")}
      beforeLine={(index) => removedRows(index + 1)}
      afterLines={removedRows(sourceLines.length + 1)}
    />
  );
});
