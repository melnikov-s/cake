import { useMemo } from "react";
import { CopyFilePathButton } from "@/components/copy-file-path-button";
import { IconButton } from "../ui/icon-button";
import { EditorIcon } from "../ui/icons";
import { syntaxTokenStyle, useHighlightedSource } from "./code";

export type DiffLine = {
  key: string;
  kind: "add" | "remove" | "context" | "meta";
  oldNumber?: number;
  newNumber?: number;
  content: string;
};

export function parseDiff(diff: string): DiffLine[] {
  let oldNumber: number | undefined;
  let newNumber: number | undefined;
  return diff.split("\n").map((line, index) => {
    const displayLine = line.match(/^([ +-])(\s*\d+) (.*)$/);
    if (displayLine) {
      const number = Number(displayLine[2]);
      const kind = displayLine[1] === "+" ? "add" : displayLine[1] === "-" ? "remove" : "context";
      return {
        key: `${index}-${line}`,
        kind,
        oldNumber: kind === "add" ? undefined : number,
        newNumber: kind === "remove" ? undefined : number,
        content: displayLine[3] ?? "",
      };
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldNumber = Number(hunk[1]);
      newNumber = Number(hunk[2]);
      return { key: `${index}-${line}`, kind: "meta", content: `@@${hunk[3] ?? ""}` };
    }
    if (line.startsWith("@@")) return { key: `${index}-${line}`, kind: "meta", content: line };
    if (
      line.startsWith("---") ||
      line.startsWith("+++") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("\\")
    ) {
      return { key: `${index}-${line}`, kind: "meta", content: line };
    }
    const marker = line[0];
    const kind = marker === "+" ? "add" : marker === "-" ? "remove" : "context";
    const parsed = {
      key: `${index}-${line}`,
      kind,
      oldNumber: kind === "add" ? undefined : oldNumber,
      newNumber: kind === "remove" ? undefined : newNumber,
      content: marker === "+" || marker === "-" || marker === " " ? line.slice(1) : line,
    } satisfies DiffLine;
    if (oldNumber !== undefined && kind !== "add") oldNumber++;
    if (newNumber !== undefined && kind !== "remove") newNumber++;
    return parsed;
  });
}

export function diffStats(diff: string) {
  const lines = parseDiff(diff);
  return {
    additions: lines.filter((line) => line.kind === "add").length,
    deletions: lines.filter((line) => line.kind === "remove").length,
  };
}

export function DiffView({
  diff,
  filePath,
  label = "Changes",
  onOpenFile,
  highlightCode = true,
}: {
  diff: string;
  filePath?: string;
  label?: string;
  onOpenFile?: (path: string) => void | Promise<void>;
  highlightCode?: boolean;
}) {
  const lines = useMemo(() => parseDiff(diff), [diff]);
  const source = useMemo(
    () => lines.map((line) => (line.kind === "meta" ? "" : line.content)).join("\n"),
    [lines],
  );
  const tokens = useHighlightedSource(filePath ?? "", source, highlightCode);
  const stats = diffStats(diff);
  return (
    <section className="diff-view" aria-label={`${label}${filePath ? ` to ${filePath}` : ""}`}>
      <header>
        <div className="group/path flex min-w-0 items-center gap-1">
          <code title={filePath}>{filePath ?? label}</code>
          {filePath && <CopyFilePathButton path={filePath} />}
        </div>
        <span>
          <b>+{stats.additions}</b>
          <i>−{stats.deletions}</i>
        </span>
        {filePath && onOpenFile && (
          <IconButton
            className="diff-editor-button"
            tooltip="Open file in editor"
            ariaLabel={`Open ${filePath} in editor`}
            onClick={() => void onOpenFile?.(filePath)}
          >
            <EditorIcon />
          </IconButton>
        )}
      </header>
      <div className="diff-scroll" role="table" aria-label="Code changes">
        {lines.map((line, index) =>
          line.kind === "meta" ? (
            <div className="diff-line diff-meta" role="row" key={line.key}>
              <span />
              <span />
              <code>{line.content}</code>
            </div>
          ) : (
            <div className={`diff-line diff-${line.kind}`} role="row" key={line.key}>
              <span
                aria-label={line.oldNumber === undefined ? undefined : `Old line ${line.oldNumber}`}
              >
                {line.oldNumber}
              </span>
              <span
                aria-label={line.newNumber === undefined ? undefined : `New line ${line.newNumber}`}
              >
                {line.newNumber}
              </span>
              <code>
                <b aria-hidden="true">
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
          ),
        )}
      </div>
    </section>
  );
}
