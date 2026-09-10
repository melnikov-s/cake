import { observer } from "r-state-tree/react";
import { Markdown } from "@/components/ai-elements/markdown";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { ShellCommand } from "@/components/ai-elements/shell-command";
import { Source } from "@/components/ai-elements/source";
import { Tool, ToolRunTimer } from "@/components/ai-elements/tool";
import { AnnotationSummary } from "@/components/annotation-summary";
import { IconButton } from "@/components/ui/icon-button";
import { EditIcon, MarkdownIcon } from "@/components/ui/icons";
import { ArtifactHost } from "@/components/artifact-host";
import { CompactionMessage } from "@/components/compaction-message";
import { ImagePreview } from "@/components/image-preview";
import type { UiPart } from "../../ipc/session-contract";
import {
  AssistantTextMessage,
  ChatTextMessage,
  type CanonicalTranscriptBehavior,
} from "./chat-message";
import { ReviewRunMessage } from "./chat-transcript-elements";
import { RetryNotice } from "./retry-notice";
import { SkillMessage } from "./skill-message";
import { SourceAttachment } from "./source-attachment";

const TranscriptPartContent = observer(function TranscriptPartContent({
  part,
  behavior,
  workLogItem = false,
  subagentStartPart,
  subagentParts,
  live,
  omitToolDiff,
}: {
  part: UiPart;
  behavior: CanonicalTranscriptBehavior;
  /** True when rendered inside a work log, so item expansion follows the global mode. */
  workLogItem?: boolean;
  subagentStartPart?: Extract<UiPart, { kind: "tool" }>;
  subagentParts?: Extract<UiPart, { kind: "tool" }>[];
  /** True while this conversation's runtime may still be producing subagent work. */
  live?: boolean;
  omitToolDiff?: boolean;
}) {
  const userMessageRendersAsMarkdown =
    part.kind === "text" && part.role === "user" && part.entryId
      ? behavior.store.transcriptInteraction.userMessageRendersAsMarkdown(
          part.entryId,
          part.renderAs === "markdown",
        )
      : false;
  if (part.kind === "text")
    return part.role === "assistant" ? (
      <AssistantTextMessage part={part} behavior={behavior} />
    ) : (
      <ChatTextMessage
        part={{
          ...part,
          renderAs: userMessageRendersAsMarkdown ? "markdown" : undefined,
        }}
        onOpenSourceLocation={behavior.openSourceLocation}
      >
        <div className="ml-auto flex min-h-[30px] items-center gap-2" aria-label="User actions">
          {part.entryId &&
            behavior.store.transcriptInteraction.canToggleUserMessageMarkdown &&
            !part.draft && (
              <IconButton
                className="pointer-events-none opacity-0 transition-opacity group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
                tooltip={
                  userMessageRendersAsMarkdown ? "Render as plain text" : "Render as Markdown"
                }
                ariaLabel={
                  userMessageRendersAsMarkdown ? "Render as plain text" : "Render as Markdown"
                }
                aria-pressed={userMessageRendersAsMarkdown}
                disabled={behavior.store.transcriptInteraction.updatingUserMessagePresentation.has(
                  part.entryId,
                )}
                onClick={() => {
                  if (part.entryId)
                    void behavior.store.transcriptInteraction.setUserMessageMarkdown(
                      part.entryId,
                      !userMessageRendersAsMarkdown,
                    );
                }}
              >
                <MarkdownIcon />
              </IconButton>
            )}
          {part.entryId === behavior.store.lastEditableUserEntryId &&
            behavior.store.canEditLastUserMessage && (
              <>
                <IconButton
                  className="pointer-events-none opacity-0 transition-opacity group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
                  tooltip="Edit message"
                  ariaLabel="Edit latest prompt"
                  onClick={() => behavior.store.editLastUserMessage(part.entryId!)}
                >
                  <EditIcon />
                </IconButton>
              </>
            )}
        </div>
      </ChatTextMessage>
    );
  if (part.kind === "skill")
    return (
      <div className="group/msg grid gap-2">
        <SkillMessage part={part} onOpenSourceLocation={behavior.openSourceLocation} />
        <div className="ml-auto min-h-[30px]">
          {part.entryId === behavior.store.lastEditableUserEntryId &&
            behavior.store.canEditLastUserMessage && (
              <IconButton
                className="pointer-events-none opacity-0 transition-opacity group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
                tooltip="Edit message"
                ariaLabel="Edit latest prompt"
                onClick={() => behavior.store.editLastUserMessage(part.entryId!)}
              >
                <EditIcon />
              </IconButton>
            )}
        </div>
      </div>
    );
  if (part.kind === "reasoning")
    return (
      <Reasoning
        open={behavior.store.workLogPresentation.itemOpen(part.id)}
        onToggle={() =>
          behavior.store.workLogPresentation.setItemOpen(
            part.id,
            !behavior.store.workLogPresentation.itemOpen(part.id),
          )
        }
        streaming={part.status === "streaming"}
        hasContent={Boolean(part.text.trim())}
      >
        <Markdown
          streaming={part.status === "streaming"}
          normalizeLatexDelimiters={part.status !== "streaming"}
          onOpenSourceLocation={behavior.openSourceLocation}
        >
          {part.text}
        </Markdown>
      </Reasoning>
    );
  if (part.kind === "command") return <ShellCommand part={part} />;
  if (part.kind === "tool") {
    const record = part.artifactId
      ? behavior.artifacts?.records.find((candidate) => candidate.artifact.id === part.artifactId)
      : undefined;
    if (record && behavior.artifacts) {
      const request =
        behavior.artifacts.interaction.request?.record.artifact.id === record.artifact.id
          ? behavior.artifacts.interaction.request
          : undefined;
      return (
        <ArtifactHost
          record={record}
          requested={Boolean(request)}
          submittedAnswer={behavior.artifacts.interaction.submittedAnswer(record.artifact)}
          onSubmit={(value) => void behavior.artifacts!.interaction.answer(record, value)}
          onSkip={() => void behavior.artifacts!.interaction.respond(undefined, true)}
          inlineWidgets={behavior.inlineWidgets}
          onOpenSourceLocation={behavior.openSourceLocation}
        />
      );
    }
    return (
      <Tool
        part={part}
        onOpenSourceLocation={behavior.openSourceLocation}
        timer={
          <ToolRunTimer
            store={behavior.store}
            partId={part.id}
            startPartId={subagentStartPart?.id}
          />
        }
        subagentStartPart={subagentStartPart}
        subagentParts={subagentParts}
        subagents={behavior.subagents}
        live={live}
        omitDiff={omitToolDiff}
        workspacePath={behavior.workspacePath}
        expansion={
          workLogItem
            ? {
                open: behavior.store.workLogPresentation.itemOpen(part.id),
                toggle: () =>
                  behavior.store.workLogPresentation.setItemOpen(
                    part.id,
                    !behavior.store.workLogPresentation.itemOpen(part.id),
                  ),
              }
            : undefined
        }
      />
    );
  }
  if (part.kind === "source") return <Source title={part.title} url={part.url} />;
  if (part.kind === "attachment")
    return part.attachmentKind === "source" && part.location ? (
      <SourceAttachment
        attachment={{ name: part.name, location: part.location }}
        onOpen={behavior.openSourceLocation}
      />
    ) : part.attachmentKind === "image" && part.data ? (
      <figure className="my-1 mb-2 ml-auto w-[min(76%,34rem)] overflow-hidden rounded-[14px] border border-border bg-card">
        <ImagePreview
          src={`data:${part.mediaType};base64,${part.data}`}
          alt={part.name}
          caption={part.name}
        />
        <figcaption className="truncate px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground">
          {part.name}
        </figcaption>
      </figure>
    ) : (
      <div className="w-fit rounded-full border border-border px-3 py-1 font-mono text-[0.68rem]">
        {part.attachmentKind} · {part.name}
      </div>
    );
  if (part.kind === "annotation")
    return <AnnotationSummary annotations={part.annotations} className="ml-auto" />;
  if (part.kind === "review-run")
    return <ReviewRunMessage run={part} onOpen={behavior.onOpenReviewRun} />;
  if (part.kind === "compaction")
    return <CompactionMessage part={part} onOpenSourceLocation={behavior.openSourceLocation} />;
  return <RetryNotice part={part} />;
});

/** Marks every rendered transcript part in the DOM so right-click selection
 *  capture can resolve any selectable surface back to its conversation part.
 *  The wrapper is layout-invisible via `display: contents`. */
export function TranscriptPart(props: {
  part: UiPart;
  behavior: CanonicalTranscriptBehavior;
  workLogItem?: boolean;
  subagentStartPart?: Extract<UiPart, { kind: "tool" }>;
  subagentParts?: Extract<UiPart, { kind: "tool" }>[];
  live?: boolean;
  omitToolDiff?: boolean;
}) {
  return (
    <div className="contents" data-part-id={props.part.id}>
      <TranscriptPartContent {...props} />
    </div>
  );
}
