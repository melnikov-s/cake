import { observer } from "r-state-tree/react";
import { Markdown } from "@/components/ai-elements/markdown";
import { Reasoning } from "@/components/ai-elements/reasoning";
import { Source } from "@/components/ai-elements/source";
import { Tool, ToolRunTimer } from "@/components/ai-elements/tool";
import { AnnotationSummary } from "@/components/annotation-summary";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { EditIcon } from "@/components/ui/icons";
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
  subagentSpawnPart,
  live,
  omitToolDiff,
}: {
  part: UiPart;
  behavior: CanonicalTranscriptBehavior;
  /** True when rendered inside a work log, so item expansion follows the global mode. */
  workLogItem?: boolean;
  subagentSpawnPart?: Extract<UiPart, { kind: "tool" }>;
  /** True while this conversation's runtime may still be producing subagent work. */
  live?: boolean;
  omitToolDiff?: boolean;
}) {
  if (part.kind === "text")
    return part.role === "assistant" ? (
      <AssistantTextMessage part={part} behavior={behavior} />
    ) : (
      <ChatTextMessage part={part} onOpenSourceLocation={behavior.openSourceLocation}>
        {part.entryId === behavior.store.lastEditableUserEntryId &&
          behavior.store.canEditLastUserMessage && (
            <div className="ml-auto flex items-center gap-2" aria-label="User actions">
              {part.draft && (
                <Button size="sm" onClick={() => void behavior.store.activateDraft()}>
                  Activate draft
                </Button>
              )}
              <IconButton
                tooltip="Edit message"
                ariaLabel="Edit latest prompt"
                onClick={() => behavior.store.editLastUserMessage(part.entryId!)}
              >
                <EditIcon />
              </IconButton>
            </div>
          )}
      </ChatTextMessage>
    );
  if (part.kind === "skill")
    return (
      <div className="grid gap-2">
        <SkillMessage part={part} onOpenSourceLocation={behavior.openSourceLocation} />
        {part.entryId === behavior.store.lastEditableUserEntryId &&
          behavior.store.canEditLastUserMessage && (
            <IconButton
              className="ml-auto"
              tooltip="Edit message"
              ariaLabel="Edit latest prompt"
              onClick={() => behavior.store.editLastUserMessage(part.entryId!)}
            >
              <EditIcon />
            </IconButton>
          )}
      </div>
    );
  if (part.kind === "reasoning")
    return (
      <Reasoning
        open={behavior.store.workLogItemOpen(part.id)}
        onToggle={() =>
          behavior.store.setWorkLogItemOpen(part.id, !behavior.store.workLogItemOpen(part.id))
        }
        streaming={part.status === "streaming"}
        hasContent={Boolean(part.text.trim())}
      >
        <Markdown
          highlightCode={part.status !== "streaming"}
          onOpenSourceLocation={behavior.openSourceLocation}
        >
          {part.text}
        </Markdown>
      </Reasoning>
    );
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
            startPartId={subagentSpawnPart?.id}
          />
        }
        subagentSpawnPart={subagentSpawnPart}
        subagents={behavior.subagents}
        renderChat={behavior.renderChat}
        live={live}
        omitDiff={omitToolDiff}
        workspacePath={behavior.workspacePath}
        expansion={
          workLogItem
            ? {
                open: behavior.store.workLogItemOpen(part.id),
                toggle: () =>
                  behavior.store.setWorkLogItemOpen(
                    part.id,
                    !behavior.store.workLogItemOpen(part.id),
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
      <figure className="transcript-image">
        <ImagePreview
          src={`data:${part.mediaType};base64,${part.data}`}
          alt={part.name}
          caption={part.name}
        />
        <figcaption>{part.name}</figcaption>
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
  subagentSpawnPart?: Extract<UiPart, { kind: "tool" }>;
  live?: boolean;
  omitToolDiff?: boolean;
}) {
  return (
    <div className="transcript-part" data-part-id={props.part.id}>
      <TranscriptPartContent {...props} />
    </div>
  );
}
