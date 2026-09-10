import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { SourceLocation } from "../../../ipc/source-location";
import { CopyFilePathButton } from "@/components/copy-file-path-button";
import { Button } from "../ui/button";
import { syntaxTokenStyle, useHighlightedSource } from "./code";
import { changedRanges } from "../../../utils/source-ranges";

export type DiffLine = {
  key: string;
  kind: "add" | "remove" | "context" | "meta";
  oldNumber?: number;
  newNumber?: number;
  content: string;
};

function parseDiff(diff: string): DiffLine[] {
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

function diffStats(diff: string) {
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
  onOpenSourceLocation,
  highlightCode = true,
  className,
  headerClassName,
}: {
  diff: string;
  filePath?: string;
  label?: string;
  onOpenSourceLocation?: (location: SourceLocation) => void | Promise<void>;
  highlightCode?: boolean;
  className?: string;
  headerClassName?: string;
}) {
  const lines = useMemo(() => parseDiff(diff), [diff]);
  const source = useMemo(
    () => lines.map((line) => (line.kind === "meta" ? "" : line.content)).join("\n"),
    [lines],
  );
  const tokens = useHighlightedSource(filePath ?? "", source, highlightCode);
  const stats = diffStats(diff);
  const changed = changedRanges(diff);
  const location = filePath
    ? {
        path: filePath,
        range:
          changed.length > 0
            ? {
                start: changed[0]!.start,
                end: changed.at(-1)!.end ?? changed.at(-1)!.start,
              }
            : undefined,
      }
    : undefined;
  return (
    <section
      className={cn(
        "min-w-0 max-w-full overflow-clip rounded-lg border border-border/80 bg-card/60 font-mono text-[11px]",
        className,
      )}
      aria-label={`${label}${filePath ? ` to ${filePath}` : ""}`}
    >
      <header
        className={cn(
          "sticky top-0 z-10 flex min-h-[31px] items-center justify-between gap-3 border-b border-border/70 bg-card/90 px-2.5 py-1 text-[10px] text-muted-foreground",
          headerClassName,
        )}
      >
        <div className="group/path flex min-w-0 items-center gap-1">
          {filePath && onOpenSourceLocation ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto min-w-0 px-1 py-0 font-mono text-xs font-semibold text-foreground"
              title={filePath}
              onClick={() => void onOpenSourceLocation(location!)}
            >
              <span className="truncate">{filePath}</span>
            </Button>
          ) : (
            <code className="truncate font-inherit font-semibold text-foreground" title={filePath}>
              {filePath ?? label}
            </code>
          )}
          {filePath && <CopyFilePathButton path={filePath} />}
        </div>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-xs">
          <b className="font-semibold text-success">+{stats.additions}</b>
          <i className="font-semibold not-italic text-destructive">−{stats.deletions}</i>
        </span>
      </header>
      <div
        className="w-full max-w-full min-w-0 overflow-x-auto py-1 font-mono text-[11px] leading-[1.55]"
        role="table"
        aria-label="Code changes"
      >
        {lines.map((line, index) =>
          line.kind === "meta" ? (
            <div
              className="my-1 grid w-max min-w-full max-w-none grid-cols-[3.5rem_3.5rem_max-content] bg-accent/10 text-muted-foreground"
              role="row"
              key={line.key}
            >
              <span className="select-none px-2 text-right" />
              <code className="col-span-2 block px-2 py-0.5 whitespace-pre [tab-size:2] text-muted-foreground">
                {line.content}
              </code>
            </div>
          ) : (
            <div
              className={cn(
                "grid w-max min-w-full max-w-none grid-cols-[3.5rem_3.5rem_max-content]",
                line.kind === "add" && "bg-success/15",
                line.kind === "remove" && "bg-destructive/15",
              )}
              role="row"
              key={line.key}
            >
              <span
                className="select-none px-2 text-right text-muted-foreground/70"
                aria-label={line.oldNumber === undefined ? undefined : `Old line ${line.oldNumber}`}
              >
                {line.oldNumber}
              </span>
              <span
                className="select-none px-2 text-right text-muted-foreground/70"
                aria-label={line.newNumber === undefined ? undefined : `New line ${line.newNumber}`}
              >
                {line.newNumber}
              </span>
              <code className="block px-2 pr-3 whitespace-pre [tab-size:2] text-foreground">
                <b
                  className={cn(
                    "inline-block w-5 select-none font-semibold text-muted-foreground",
                    line.kind === "add" && "text-success",
                    line.kind === "remove" && "text-destructive",
                  )}
                  aria-hidden="true"
                >
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
