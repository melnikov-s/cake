import { observer } from "r-state-tree/react";
import { InlineArtifactContext } from "./inline-artifact-context";
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
import { TranscriptImageAttachment } from "./transcript-image-attachment";
import { isAttachmentImageMimeType } from "../../contracts/conversations/attachment-reference-control";
import { toolImagesAreConversationResults } from "../../utils/cake-tool";
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
import { SessionUpdateEntry } from "./session-update-entry";
import { SkillMessage } from "./skill-message";
import { SourceAttachment } from "./source-attachment";
import { SessionMessage } from "./session-message";
import { messageNavigationTarget } from "../../contracts/conversations/message-reference";
import { parseSubagentLink, subagentLink } from "../../contracts/subagents/subagent-reference";
import { referenceTodoOrigin, resultTodoOrigin } from "../lib/result-todo-origin";

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
  if (part.kind === "text" && part.agentSource) {
    const worker = parseSubagentLink(part.agentSource.href);
    return (
      <ChatTextMessage
        part={part}
        onOpenSourceLocation={behavior.openSourceLocation}
        workerTask={
          worker && worker.parentSessionId === behavior.subagents?.parentSessionId
            ? behavior.subagents.run(worker.handleId)?.task
            : undefined
        }
      />
    );
  }
  if (part.kind === "text" && part.subagentReport) {
    const sources = behavior.store.messageSources.filter(
      (source) => source.props.partId === part.id,
    );
    return (
      <ChatTextMessage
        part={part}
        onOpenSourceLocation={behavior.openSourceLocation}
        reportSource={{
          href: behavior.messageReferenceSessionId
            ? subagentLink(behavior.messageReferenceSessionId, part.subagentReport.handleId)
            : undefined,
        }}
        sources={sources}
        todo={
          behavior.hideTodoAssociations
            ? undefined
            : {
                origin: resultTodoOrigin(
                  part,
                  behavior.messageReferenceSessionId ?? behavior.store.id,
                ),
                todos: behavior.todos,
              }
        }
      />
    );
  }
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
      if (source)
        return (
          <SessionMessage
            source={{ sessionId: messageNavigationTarget(part.messageReference).sessionId }}
            sources={[source]}
            todo={
              behavior.hideTodoAssociations
                ? undefined
                : { origin: referenceTodoOrigin(part.messageReference), todos: behavior.todos }
            }
          />
        );
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
            (part.artifactRevision
              ? `cake://artifact/${part.artifactId}@r${part.artifactRevision}`
              : behavior.messageReferenceSessionId
                ? behavior.inlineArtifactPreviews.publicationReference(
                    part.artifactId,
                    behavior.messageReferenceSessionId,
                  )
                : `cake://artifact/${part.artifactId}`)
          }
          stateSessionId={behavior.messageReferenceSessionId}
          store={behavior.inlineArtifactPreviews}
          inlineWidgets={behavior.inlineWidgets}
        />
      );
    if (record)
      return (
        <ArtifactHost
          record={record}
          stateSessionId={behavior.messageReferenceSessionId}
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
        omitOutputImages={workLogItem && toolImagesAreConversationResults(part)}
        workspacePath={behavior.workspacePath}
        homeDirectory={behavior.store.workLogPresentation.homeDirectory}
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
    const updates = behavior.store.sessionUpdates.filter((entry) => entry.props.partId === part.id);
    if (updates.length)
      return (
        <SessionResultNotice>
          {updates.map((entry) => (
            <SessionUpdateEntry
              key={entry.props.entry.key}
              store={entry}
              onOpenSourceLocation={behavior.openSourceLocation}
              todos={behavior.todos}
            />
          ))}
        </SessionResultNotice>
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
    ) : (part.attachmentKind === "image" && part.data) ||
      (part.inputReference &&
        behavior.store.attachmentImages &&
        isAttachmentImageMimeType(part.inputReference.mimeType)) ? (
      <TranscriptImageAttachment
        part={part}
        sessionId={behavior.messageReferenceSessionId}
        images={behavior.store.attachmentImages}
      />
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
    <InlineArtifactContext
      value={{
        conversationId: props.behavior.store.id,
        partId: props.part.id,
        behavior: props.behavior,
      }}
    >
      <div className="contents" data-part-id={props.part.id}>
        <TranscriptPartContent {...props} />
        {props.part.kind === "text" &&
          !props.part.crossSession &&
          !props.part.subagentReport &&
          props.behavior.store.messageSources
            .filter((source) => source.props.partId === props.part.id)
            .map((source) => (
              <SessionMessage
                key={source.props.reference}
                source={{ sessionId: messageNavigationTarget(source.props.reference!).sessionId }}
                sources={[source]}
                todo={
                  props.behavior.hideTodoAssociations
                    ? undefined
                    : {
                        origin: referenceTodoOrigin(source.props.reference!),
                        todos: props.behavior.todos,
                      }
                }
              />
            ))}
      </div>
    </InlineArtifactContext>
  );
});
