import { observer } from "r-state-tree/react";
import { Markdown } from "@/components/ai-elements/markdown";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { ShellCommand } from "@/components/ai-elements/shell-command";
import { Source } from "@/components/ai-elements/source";
import { Tool, ToolRunTimer } from "@/components/ai-elements/tool";
import { AnnotationSummary } from "@/components/annotation-summary";
import { Badge } from "@/components/ui/badge";
import { AttachmentReference } from "./ui/attachment-reference";
import { IconButton } from "@/components/ui/icon-button";
import { BrowserIcon, EditIcon, MarkdownIcon, TreeIcon } from "@/components/ui/icons";
import { Interview } from "@/components/interview";
import { ArtifactHost } from "@/components/artifact-host";
import { InlineArtifactPreview } from "./inline-artifact-preview";
import { CompactionMessage } from "@/components/compaction-message";
import { ImagePreview } from "@/components/image-preview";
import type { UiPart } from "../../contracts/conversations/session-contract";
import {
  AssistantTextMessage,
  ChatTextMessage,
  type CanonicalTranscriptBehavior,
} from "./chat-message";
import { ReviewRunMessage } from "./chat-transcript-elements";
import { RetryNotice } from "./retry-notice";
import { ContextPill } from "./ui/context-pill";
import { SessionResultNotice } from "./ui/session-result-notice";
import { sessionNotificationMarkdown } from "../../contracts/cake-chats/session-digest-reminder";
import { SkillMessage } from "./skill-message";
import { SourceAttachment } from "./source-attachment";
import { InlineMessageSource } from "./inline-message-source";

const artifactReferenceInText =
  /(?:^|\s)cake:\/\/artifact\/[A-Za-z0-9][A-Za-z0-9._:-]*(?:@r[1-9][0-9]*)?(?=$|[\s),.;!?])/;

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
  const hasArtifactReference =
    part.kind === "text" && part.role === "user" && artifactReferenceInText.test(part.text);
  const userMessageDisplaysAsMarkdown = userMessageRendersAsMarkdown || hasArtifactReference;
  if (part.kind === "text" && part.subagentReport)
    return <ChatTextMessage part={part} onOpenSourceLocation={behavior.openSourceLocation} />;
  if (part.kind === "text")
    return part.role === "assistant" || part.crossSession ? (
      <AssistantTextMessage part={part} behavior={behavior} />
    ) : (
      <ChatTextMessage
        part={{
          ...part,
          renderAs: userMessageDisplaysAsMarkdown ? "markdown" : undefined,
        }}
        onOpenSourceLocation={behavior.openSourceLocation}
      >
        <div className="ml-auto flex min-h-[30px] items-center gap-2" aria-label="User actions">
          {part.entryId &&
            behavior.store.transcriptInteraction.canToggleUserMessageMarkdown &&
            !hasArtifactReference &&
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
          {part.entryId && behavior.onTree && !part.draft && (
            <IconButton
              className="pointer-events-none opacity-0 transition-opacity group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
              tooltip="Continue here in session tree"
              ariaLabel="Continue from message in session tree"
              onClick={() => behavior.onTree!(part.entryId!)}
            >
              <TreeIcon />
            </IconButton>
          )}
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
      </ChatTextMessage>
    );
  if (part.kind === "skill")
    return (
      <div className="group/msg grid gap-2">
        <SkillMessage part={part} onOpenSourceLocation={behavior.openSourceLocation} />
        <div className="ml-auto flex min-h-[30px] items-center gap-2">
          {part.entryId && behavior.onTree && (
            <IconButton
              className="pointer-events-none opacity-0 transition-opacity group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
              tooltip="Continue here in session tree"
              ariaLabel="Continue from message in session tree"
              onClick={() => behavior.onTree!(part.entryId!)}
            >
              <TreeIcon />
            </IconButton>
          )}
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
    if (part.messageReference) {
      const source = behavior.store.messageSources.find((store) => store.props.partId === part.id);
      if (source) return <InlineMessageSource store={source} />;
    }
    const interviewId = part.interview?.id;
    if (interviewId) {
      const store = behavior.interviews?.find((candidate) => candidate.record.id === interviewId);
      if (store) return <Interview store={store} inlineWidgets={behavior.inlineWidgets} />;
    }
    const record = part.artifactId
      ? behavior.artifacts?.records.find((candidate) => candidate.artifact.id === part.artifactId)
      : undefined;
    if (part.artifactId && behavior.inlineArtifactPreviews && behavior.inlineWidgets)
      return (
        <InlineArtifactPreview
          reference={
            part.artifactReference ??
            behavior.inlineArtifactPreviews.publicationReference(part.artifactId, behavior.store.id)
          }
          stateSessionId={behavior.store.id}
          store={behavior.inlineArtifactPreviews}
          inlineWidgets={behavior.inlineWidgets}
        />
      );
    if (record)
      return (
        <ArtifactHost
          record={record}
          stateSessionId={behavior.store.id}
          inlineWidgets={behavior.inlineWidgets}
          onOpenSourceLocation={behavior.openSourceLocation}
          presentation="inline"
        />
      );
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
        omitOutputImages={workLogItem}
        workspacePath={behavior.workspacePath}
        nestedExpansion={
          workLogItem
            ? (partId) => ({
                open: behavior.store.workLogPresentation.itemOpen(partId),
                toggle: () =>
                  behavior.store.workLogPresentation.setItemOpen(
                    partId,
                    !behavior.store.workLogPresentation.itemOpen(partId),
                  ),
              })
            : undefined
        }
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
  if (part.kind === "context") {
    const notification = sessionNotificationMarkdown(part.text);
    if (notification)
      return (
        <div className="flex min-w-0 flex-col gap-3">
          <SessionResultNotice
            text={notification}
            onOpenSourceLocation={behavior.openSourceLocation}
          />
          {behavior.store.messageSources
            .filter((source) => source.props.partId === part.id)
            .map((source) => (
              <InlineMessageSource key={source.props.reference} store={source} />
            ))}
        </div>
      );
    return (
      <ContextPill
        title={part.title}
        text={part.text}
        onOpenSourceLocation={behavior.openSourceLocation}
      />
    );
  }
  if (part.kind === "source") return <Source title={part.title} url={part.url} />;
  if (part.kind === "attachment")
    return part.attachmentKind === "source" && part.location ? (
      <SourceAttachment
        attachment={{
          name: part.name,
          location: part.location,
          selectedText: part.selectedText,
          comment: part.comment,
        }}
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
    ) : part.attachmentKind === "browser" ? (
      <Badge variant="mono" className="w-fit">
        <BrowserIcon />
        {part.selector || part.name}
      </Badge>
    ) : part.inputReference && behavior.messageReferenceSessionId ? (
      <AttachmentReference
        sessionId={behavior.messageReferenceSessionId}
        reference={part.inputReference}
      />
    ) : (
      <Badge variant="mono" className="w-fit">
        {part.name}
      </Badge>
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
export const TranscriptPart = observer(function TranscriptPart(props: {
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
      {props.part.kind === "text" &&
        props.behavior.store.messageSources
          .filter((source) => source.props.partId === props.part.id)
          .map((source) => <InlineMessageSource key={source.props.reference} store={source} />)}
    </div>
  );
});
