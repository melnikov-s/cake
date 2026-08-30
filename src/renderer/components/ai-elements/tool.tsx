import { useEffect, useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "../../../ipc/json-contract";
import type { ToolOutputContent, UiPart } from "../../../ipc/session-contract";
import type { SourceLocation } from "../../../ipc/source-location";
import type { ChatStore } from "../../stores/ChatStore";
import { toolOperationName } from "../../../utils/cake-tool";
import { toolDiff } from "../../../utils/turn-diff";
import { toolSourceRange } from "../../../utils/source-ranges";
import { toWorkspaceRelativePath } from "../../../utils/workspace-relative-path";
import { Button } from "../ui/button";
import { StatusDot } from "../ui/status-dot";
import { formatElapsed } from "../ui/loading-state";
import { DiffView } from "./diff-view";
import { languageForSource } from "./code";
import { fencedCode, Markdown } from "./markdown";
import { SubagentTool } from "./subagent-tool";
import type { SubagentActivityStore } from "../../stores/SubagentActivityStore";
import { ImagePreview } from "@/components/image-preview";
import { CopyFilePathButton } from "@/components/copy-file-path-button";

function parseJson(value: string) {
  try {
    return jsonValueSchema.parse(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function toolPath(part: Extract<UiPart, { kind: "tool" }>) {
  if (part.filePath) return part.filePath;
  const parsed = parseJson(part.input);
  const structuredResult = jsonObjectSchema.safeParse(parsed);
  if (!structuredResult.success) return undefined;
  return ["path", "file_path"]
    .map((key) => z.string().safeParse(structuredResult.data[key]))
    .find((result) => result.success)?.data;
}

function toolTitle(
  part: Extract<UiPart, { kind: "tool" }>,
  concise = false,
  workspacePath?: string,
) {
  const operationName = toolOperationName(part);
  const filePath = toolPath(part);
  const displayPath = filePath ? toWorkspaceRelativePath(filePath, workspacePath) : undefined;
  if (concise && filePath) return operationName;
  if (operationName === "edit" && displayPath) return `edit ${displayPath}`;

  const parsed = parseJson(part.input);
  const structuredResult = jsonObjectSchema.safeParse(parsed);
  const structured = structuredResult.success ? structuredResult.data : undefined;
  const parsedString = z.string().safeParse(parsed);
  const detail =
    operationName === "bash"
      ? part.input
      : (displayPath ??
        (part.name === "cake"
          ? undefined
          : ["command", "query", "pattern", "url"]
              .map((key) => z.string().safeParse(structured?.[key]))
              .find((result) => result.success)?.data) ??
        (parsedString.success ? parsedString.data : parsed === undefined ? part.input : ""));
  const summary = oneLine(detail);
  return summary ? `${operationName} ${summary}` : operationName;
}

function toolCode(value: string, className: string, highlightCode: boolean) {
  const parsed = parseJson(value);
  const source = parsed === undefined ? value : JSON.stringify(parsed, null, 2);
  const language = parsed === undefined ? "text" : "json";
  return (
    <Markdown className={className} highlightCode={highlightCode}>
      {fencedCode(source, language)}
    </Markdown>
  );
}

function toolText(value: string, className: string, language: string, highlightCode: boolean) {
  return (
    <Markdown className={className} highlightCode={highlightCode}>
      {fencedCode(value, language)}
    </Markdown>
  );
}

function toolOutputContent(
  content: readonly ToolOutputContent[],
  className: string,
  language: string,
  highlightCode: boolean,
) {
  return content.map((item, index) =>
    item.type === "text" ? (
      <Markdown className={className} highlightCode={highlightCode} key={`text-${index}`}>
        {fencedCode(item.text, language)}
      </Markdown>
    ) : (
      <figure
        className="my-2 overflow-hidden rounded-[10px] border border-border bg-background"
        key={`image-${index}`}
      >
        <ImagePreview
          src={`data:${item.mimeType};base64,${item.data}`}
          alt={`Tool output image ${index + 1}`}
        />
      </figure>
    ),
  );
}

function toolOutput(
  part: Extract<UiPart, { kind: "tool" }>,
  className: string,
  language: string,
  highlightCode: boolean,
) {
  if (part.outputContent && part.outputContent.length > 0)
    return toolOutputContent(part.outputContent, className, language, highlightCode);
  if (part.output === undefined) return null;
  return toolText(part.output, className, language, highlightCode);
}

function readToolCode(part: Extract<UiPart, { kind: "tool" }>, highlightCode: boolean) {
  const path = toolPath(part);
  return toolOutput(part, "mt-3 text-xs", path ? languageForSource(path) : "text", highlightCode);
}

function editorLocation(part: Extract<UiPart, { kind: "tool" }>): SourceLocation | undefined {
  if (part.name !== "read" && part.name !== "write" && part.name !== "edit") return undefined;
  const path = toolPath(part);
  if (!path) return undefined;
  const range = part.name === "read" ? undefined : toolSourceRange(part);
  return { path, range };
}

/** Count-up elapsed-time chip for a work log tool item; frozen once the item finishes. */
export const ToolRunTimer = observer(function ToolRunTimer({
  store,
  partId,
  startPartId,
}: {
  store: ChatStore;
  partId: string;
  startPartId?: string;
}) {
  const elapsedMs = startPartId
    ? store.workLogElapsedMsRange(startPartId, partId)
    : store.workLogElapsedMs(partId);
  if (elapsedMs === undefined) return null;
  return (
    <span
      className="flex items-center gap-1 font-mono text-[10px] tabular-nums text-muted-foreground whitespace-nowrap"
      aria-label="elapsed time"
    >
      {formatElapsed(elapsedMs)}
    </span>
  );
});

export function Tool({
  part,
  onOpenSourceLocation,
  timer,
  expansion,
  subagentSpawnPart,
  subagents,
  renderChat,
  live = false,
  omitDiff,
  workspacePath,
}: {
  part: Extract<UiPart, { kind: "tool" }>;
  onOpenSourceLocation?: (location: SourceLocation) => void | Promise<void>;
  timer?: ReactNode;
  /** Controlled expansion inside a work log; uncontrolled local state otherwise. */
  expansion?: { open: boolean; toggle(): void };
  /** The matching spawn call when Cake presents spawn + wait as one subagent run. */
  subagentSpawnPart?: Extract<UiPart, { kind: "tool" }>;
  subagents?: SubagentActivityStore;
  renderChat?(store: ChatStore): ReactNode;
  /** True while this conversation's runtime may still be producing subagent work. */
  live?: boolean;
  omitDiff?: boolean;
  /** Project root used only to shorten displayed in-project paths. */
  workspacePath?: string;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = expansion ? expansion.open : uncontrolledOpen;
  const [detailsMounted, setDetailsMounted] = useState(open);
  useEffect(() => {
    if (open) setDetailsMounted(true);
  }, [open]);
  const toggleOpen = () => {
    if (!open) setDetailsMounted(true);
    if (expansion) expansion.toggle();
    else setUncontrolledOpen((value) => !value);
  };
  if (toolOperationName(part).startsWith("subagents."))
    return (
      <SubagentTool
        part={part}
        spawnPart={subagentSpawnPart}
        subagents={subagents}
        renderChat={renderChat}
        live={live}
        timer={timer}
        expansion={expansion}
      />
    );
  const diff = omitDiff ? undefined : toolDiff(part);
  const location = editorLocation(part);
  const filePath = location?.path;
  const displayPath = filePath ? toWorkspaceRelativePath(filePath, workspacePath) : undefined;
  const path = onOpenSourceLocation ? displayPath : undefined;
  const title = toolTitle(part, Boolean(path), workspacePath);
  const read = part.name === "read";
  const bash = part.name === "bash" && part.input ? part.input : undefined;
  const hasDetails = Boolean(
    diff || bash || part.input || part.output || part.outputContent?.length,
  );
  return (
    <div className="rounded-xl border border-border bg-muted/35 px-4 py-3">
      <div className="flex items-center justify-between gap-3 min-w-0">
        <div className="group/path flex min-w-0 flex-1 items-center">
          <button
            type="button"
            className="flex items-center gap-2 min-w-0 cursor-pointer font-mono text-xs font-semibold text-foreground text-left"
            onClick={toggleOpen}
            aria-expanded={open}
            disabled={!hasDetails}
          >
            <StatusDot
              status={
                part.state === "running"
                  ? "running"
                  : part.state === "success"
                    ? "complete"
                    : part.state === "error" || part.state === "denied"
                      ? "failed"
                      : part.state === "interrupted"
                        ? "interrupted"
                        : "ready"
              }
            />
            <span className="truncate" title={title}>
              {title}
            </span>
          </button>
          {path && onOpenSourceLocation ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-auto min-w-0 px-1 py-0 font-mono text-xs"
              title={path}
              onClick={() => void onOpenSourceLocation(location!)}
            >
              <span className="truncate">{path}</span>
            </Button>
          ) : null}
          {displayPath && <CopyFilePathButton path={displayPath} />}
        </div>
        {timer}
      </div>
      {/* Once opened, keep details mounted so later toggles do not feed Streamdown's passive update back into Virtuoso measurement. */}
      {hasDetails && detailsMounted && (
        <div className="mt-1" hidden={!open}>
          {read ? (
            readToolCode(part, part.state !== "running")
          ) : diff ? (
            <DiffView
              diff={diff}
              filePath={
                part.filePath
                  ? toWorkspaceRelativePath(part.filePath, workspacePath)
                  : part.filePath
              }
              label={part.state === "running" ? "Proposed edit" : "Applied edit"}
              highlightCode={part.state !== "running"}
              onOpenSourceLocation={onOpenSourceLocation}
            />
          ) : bash ? (
            <Markdown className="mt-3 text-xs" highlightCode={part.state !== "running"}>
              {fencedCode(bash, "bash")}
            </Markdown>
          ) : (
            part.input && toolCode(part.input, "mt-3 text-xs", part.state !== "running")
          )}
          {!diff &&
            !read &&
            toolOutput(
              part,
              "mt-3 border-t border-border pt-3 text-xs",
              "text",
              part.state !== "running",
            )}
        </div>
      )}
    </div>
  );
}
