import { useEffect, useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import type {
  NestedToolCall,
  ToolOutputContent,
  UiPart,
} from "../../../contracts/conversations/session-contract";
import type { SourceLocation } from "../../../contracts/editor/source-location";
import type { ChatStore } from "../../stores/ChatStore";
import { toolOperationName } from "../../../utils/cake-tool";
import { toolDiff } from "../../../utils/turn-diff";
import { toolSourceRange } from "../../../utils/source-ranges";
import { toWorkspaceRelativePath } from "../../../utils/workspace-relative-path";
import { Button } from "../ui/button";
import { DisclosureTrigger } from "../ui/disclosure-trigger";
import { formatElapsed } from "../ui/loading-state";
import { DiffView } from "./diff-view";
import { languageForSource } from "./code";
import { fencedCode, Markdown } from "./markdown";
import { SubagentTool } from "./subagent-tool";
import type { SubagentActivityStore } from "../../stores/SubagentActivityStore";
import { ImagePreview } from "@/components/image-preview";
import { CopyFilePathButton } from "@/components/copy-file-path-button";
import { parseToolInput, toolDisplayTitle, toolPath } from "@/lib/tool-presentation";

function toolCode(value: string, className: string, streaming: boolean) {
  const parsed = parseToolInput(value);
  const source = parsed === undefined ? value : JSON.stringify(parsed, null, 2);
  const language = parsed === undefined ? "text" : "json";
  return (
    <Markdown className={className} streaming={streaming} mutableCode={streaming}>
      {fencedCode(source, language)}
    </Markdown>
  );
}

// A tool can replace its partial output with a different final result. Reset only
// that Markdown parser at settlement so Streamdown does not retain the partial fence.
function toolText(value: string, className: string, language: string, streaming: boolean) {
  return (
    <Markdown
      key={streaming ? "live" : "settled"}
      className={className}
      streaming={streaming}
      mutableCode={streaming}
    >
      {fencedCode(value, language)}
    </Markdown>
  );
}

function toolOutputContent(
  content: readonly ToolOutputContent[],
  className: string,
  language: string,
  streaming: boolean,
  omitImages: boolean,
  imageAlt: string | undefined,
) {
  return content.map((item, index) =>
    item.type === "text" ? (
      <Markdown
        className={className}
        streaming={streaming}
        mutableCode={streaming}
        key={`text-${index}-${streaming ? "live" : "settled"}`}
      >
        {fencedCode(item.text, language)}
      </Markdown>
    ) : omitImages ? null : (
      <figure
        className="my-2 overflow-hidden rounded-[10px] border border-border bg-background"
        key={`image-${index}`}
      >
        <ImagePreview
          src={`data:${item.mimeType};base64,${item.data}`}
          alt={imageAlt ?? `Tool output image ${index + 1}`}
          imageClassName="max-h-96 w-auto"
        />
      </figure>
    ),
  );
}

function toolOutput(
  part: Extract<UiPart, { kind: "tool" }>,
  className: string,
  language: string,
  streaming: boolean,
  omitImages: boolean,
) {
  if (part.outputContent && part.outputContent.length > 0) {
    const read = part.name === "read";
    const path = read ? toolPath(part) : undefined;
    // An image read's text only restates "Read image file [mime]"; the image is the result.
    const content =
      read && part.outputContent.some((item) => item.type === "image")
        ? part.outputContent.filter((item) => item.type === "image")
        : part.outputContent;
    return toolOutputContent(
      content,
      className,
      language,
      streaming,
      omitImages,
      path?.split(/[\\/]/).at(-1),
    );
  }
  if (part.output === undefined) return null;
  return toolText(part.output, className, language, streaming);
}

function readToolCode(
  part: Extract<UiPart, { kind: "tool" }>,
  streaming: boolean,
  omitImages: boolean,
) {
  const path = toolPath(part);
  return toolOutput(
    part,
    "mt-3 text-xs",
    path ? languageForSource(path) : "text",
    streaming,
    omitImages,
  );
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
    ? store.workLogPresentation.elapsedMsRange(startPartId, partId)
    : store.workLogPresentation.elapsedMs(partId);
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

export const Tool = observer(function Tool({
  part,
  onOpenSourceLocation,
  timer,
  expansion,
  subagentStartPart,
  subagentParts,
  subagents,
  live = false,
  omitDiff,
  omitOutputImages = false,
  workspacePath,
  activity,
  nestedExpansion,
}: {
  part: Extract<UiPart, { kind: "tool" }>;
  onOpenSourceLocation?: (location: SourceLocation) => void | Promise<void>;
  timer?: ReactNode;
  /** Controlled expansion inside a work log; uncontrolled local state otherwise. */
  expansion?: { open: boolean; toggle(): void };
  /** The matching background start when Cake unifies later completion or wait activity. */
  subagentStartPart?: Extract<UiPart, { kind: "tool" }>;
  subagentParts?: Extract<UiPart, { kind: "tool" }>[];
  subagents?: SubagentActivityStore;
  /** True while this conversation's runtime may still be producing subagent work. */
  live?: boolean;
  omitDiff?: boolean;
  /** The conversation renders this tool's result images beneath the collapsed work log. */
  omitOutputImages?: boolean;
  /** Project root used only to shorten displayed in-project paths. */
  workspacePath?: string;
  /** Child metadata is separate from an ordinary transcript tool result. */
  activity?: NestedToolCall;
  nestedExpansion?: (partId: string) => { open: boolean; toggle(): void };
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
  if (!activity && toolOperationName(part).startsWith("subagents."))
    return (
      <SubagentTool
        part={part}
        startPart={subagentStartPart}
        protocolParts={subagentParts}
        subagents={subagents}
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
  const title = toolDisplayTitle(part, Boolean(path), workspacePath);
  const read = part.name === "read";
  const bash = part.name === "bash" && part.input ? part.input : undefined;
  const script = part.name === "codemode" && part.input ? part.input : undefined;
  const hasDetails = Boolean(
    diff ||
    bash ||
    part.input ||
    part.output !== undefined ||
    part.outputContent?.length ||
    part.nestedCalls ||
    activity?.outputAvailability === "unavailable",
  );
  return (
    <div data-slot="tool" className="rounded-xl border border-border bg-muted/35 px-4 py-3">
      <div className="flex items-center justify-between gap-3 min-w-0">
        <div className="group/path flex min-w-0 flex-1 items-center">
          <DisclosureTrigger
            className="flex-1"
            title={title}
            subtitle={part.nestedCalls ? `${part.nestedCalls.calls.length} tool calls` : undefined}
            showChevron={false}
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
            onClick={toggleOpen}
            open={open}
            disabled={!hasDetails}
          />
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
        {activity?.durationMs !== undefined && (
          <span
            className="font-mono text-[10px] tabular-nums text-muted-foreground"
            aria-label="elapsed time"
          >
            {formatElapsed(activity.durationMs)}
          </span>
        )}
      </div>
      {/* Once opened, keep details mounted so later toggles do not feed Streamdown's passive update back into Virtuoso measurement. */}
      {hasDetails && detailsMounted && (
        <div data-slot="tool-details" className="mt-1" hidden={!open}>
          {activity?.inputUnavailable && (
            <p className="mt-3 text-xs text-muted-foreground">
              Arguments not recorded
              {activity.argumentsBytes !== undefined ? ` (${activity.argumentsBytes} bytes)` : ""}.
            </p>
          )}
          {read && !activity ? (
            readToolCode(part, part.state === "running", omitOutputImages)
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
          ) : script ? (
            <div className="mt-3">
              <p className="text-xs text-muted-foreground">Script</p>
              {toolText(script, "mt-1 text-xs", "javascript", part.state === "running")}
            </div>
          ) : bash ? (
            <Markdown
              className="mt-3 text-xs"
              streaming={part.state === "running"}
              mutableCode={part.state === "running"}
            >
              {fencedCode(bash, "bash")}
            </Markdown>
          ) : (
            part.input && toolCode(part.input, "mt-3 text-xs", part.state === "running")
          )}
          {script && part.output !== undefined && (
            <p className="mt-3 text-xs text-muted-foreground">Returned output</p>
          )}
          {!diff &&
            (!read || activity) &&
            toolOutput(
              part,
              "mt-3 border-t border-border pt-3 text-xs",
              "text",
              part.state === "running",
              omitOutputImages,
            )}
          {activity?.errorSummary && (
            <div className="mt-3 text-xs">
              <p className="text-muted-foreground">Recorded error summary</p>
              {toolText(activity.errorSummary, "mt-1 text-xs", "text", false)}
            </div>
          )}
          {activity?.outputAvailability === "unavailable" && (
            <p className="mt-3 text-xs text-muted-foreground">
              Output unavailable in saved history. Pi records child-call metadata, not returned
              output.
            </p>
          )}
          {part.nestedCalls && (
            <section
              className="mt-3 grid gap-2 border-t border-border pt-3"
              aria-label="Nested tool activity"
            >
              <p className="text-xs text-muted-foreground">
                Tool calls
                {part.nestedCalls.complete === false
                  ? " · Incomplete record (calls, arguments, or completion may be missing)"
                  : ""}
              </p>
              {part.nestedCalls.calls.map((call) => (
                <Tool
                  key={call.id}
                  part={{ kind: "tool", ...call }}
                  activity={call}
                  onOpenSourceLocation={onOpenSourceLocation}
                  workspacePath={workspacePath}
                  expansion={nestedExpansion?.(call.id)}
                />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
});
