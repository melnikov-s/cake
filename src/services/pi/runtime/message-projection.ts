import { parseSkillBlock, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@earendil-works/pi-ai";
import { Option, Schema } from "effect";
import {
  withoutPassiveNotices,
  type InternalInput,
} from "../../../contracts/conversations/internal-input";
import { MessageMetadata } from "../../../contracts/conversations/message-reference";
import type { TaskInputReference } from "../../../contracts/conversations/task-input";
import { ArtifactProjectionMetadata } from "../../../contracts/artifacts/artifact-projection-data";
import { familyBootstrapContext } from "../../../contracts/conversations/family-bootstrap";
import {
  describeTurnStop,
  TURN_STOPPED_NOTICE_TITLE,
  type TurnStop,
} from "../../../contracts/conversations/turn-stop";
import type { UiPart } from "../../../contracts/conversations/session-contract";
import { shouldRenderMarkdown } from "../../../utils/markdown";
import {
  internalInputPart,
  subagentCompletionPart,
  passiveNoticeParts,
  agentUpdatePart,
} from "./internal-input-projection";
import { splitContextReminders } from "./session-context-reminders";
import {
  createSystemContextProjector,
  withoutRuntimeSystemPrompt,
} from "./system-context-projection";
import { parseContextAttachmentBlocks, parseUserMessageEnvelope } from "./user-message-transport";
import {
  boundedProjectionKey,
  cakeOperationCommand,
  formatToolInput,
  formatUnknown,
  projectNestedToolCalls,
  projectToolOutputContent,
  shellCommandPart,
  textFromContent,
  toolArtifactId,
  toolArtifactRevision,
  toolFilePath,
  toolResultDiff,
} from "./tool-projection";

/**
 * How an aborted assistant message reads. `interrupted` is an unexpected cut-off and keeps the
 * failure presentation; a handoff hides it (even when the abort surfaced as an `error` stop);
 * a deliberate stop shows a neutral notice.
 */
export type AbortPresentation =
  | { readonly kind: "interrupted" }
  | { readonly kind: "handoff" }
  | { readonly kind: "stopped"; readonly stop: TurnStop };
const interruptedAbort: AbortPresentation = { kind: "interrupted" };
export function partsFromMessage(
  message: unknown,
  baseId: string,
  streaming = false,
  entryId?: string,
  renderUserMessageAsMarkdown = false,
  streamingContentIndex?: number,
  abortPresentation: AbortPresentation = interruptedAbort,
  internal?: InternalInput,
): UiPart[] {
  if (typeof message !== "object" || message === null) return [];
  const role = Reflect.get(message, "role");
  const content = Reflect.get(message, "content");

  if (role === "user") {
    const parts: UiPart[] = [];
    // Pi preserves the message timestamp when a live input becomes a durable entry.
    // Both the skill and text part represent consumption of this same input.
    const timestamp = Reflect.get(message, "timestamp");
    const renderKey =
      typeof timestamp === "number" && Number.isFinite(timestamp) ? `user-${timestamp}` : undefined;
    if (internal?._tag === "AgentUpdate") return [agentUpdatePart(internal.update)];
    const rawContext = splitContextReminders(
      withoutPassiveNotices(textFromContent(content), internal),
    );
    const context = {
      ...rawContext,
      text:
        internal?._tag === "UserWithReminders" && internal.userText !== undefined
          ? internal.userText
          : internal?._tag === "UpdateBatch"
            ? ""
            : rawContext.text,
    };
    const envelope = parseUserMessageEnvelope(
      context.text,
      internal?._tag === "UserWithReminders" && internal.userText !== undefined,
    );
    const reminderParts = context.reminders
      .filter(
        (reminder) =>
          !(
            (internal?._tag === "UpdateBatch" ||
              (internal?._tag === "UserWithReminders" && internal.userText !== undefined)) &&
            (reminder.title === "Cake · reference notifications" ||
              reminder.title === "Cake · batched updates")
          ),
      )
      .map((reminder, index): UiPart => ({
        id: `${baseId}-context-${index}`,
        kind: "context",
        title: reminder.title,
        text: reminder.text,
      }));
    const parsedContext = parseContextAttachmentBlocks(envelope.text);
    const text = parsedContext.text;
    // Exact human prose excludes host-appended attachment envelopes. Read those
    // from the original transport, independently of reminder/prose filtering.
    const attachments =
      internal?._tag === "UserWithReminders" && internal.userText !== undefined
        ? parseContextAttachmentBlocks(rawContext.text).attachments
        : parsedContext.attachments;
    const bootstrap = familyBootstrapContext(text, envelope.crossSession);
    if (bootstrap)
      return [
        ...reminderParts,
        { id: `${baseId}-context`, kind: "context", title: "Family bootstrap", text: bootstrap },
      ];
    const renderAsMarkdown =
      renderUserMessageAsMarkdown || Boolean(envelope.crossSession && shouldRenderMarkdown(text));
    const skill = parseSkillBlock(text);
    if (skill) {
      parts.push({
        id: `${baseId}-skill`,
        kind: "skill",
        entryId,
        renderKey,
        name: skill.name,
        content: skill.content,
      });
      if (skill.userMessage)
        parts.push({
          id: `${baseId}-text`,
          kind: "text",
          role: "user",
          entryId,
          renderKey,
          text: skill.userMessage,
          status: "complete",
          renderAs: renderAsMarkdown ? "markdown" : undefined,
          crossSession: envelope.crossSession,
          scheduled: envelope.scheduled,
        });
    } else if (text)
      parts.push({
        id: `${baseId}-text`,
        kind: "text",
        role: "user",
        entryId,
        renderKey,
        text,
        status: "complete",
        renderAs: renderAsMarkdown ? "markdown" : undefined,
        crossSession: envelope.crossSession,
        scheduled: envelope.scheduled,
      });
    // Project Sessions send each image as pixels plus a file tag naming its pinned
    // original. Present the pair as one named image, as the composer showed it.
    const imageBlocks = Array.isArray(content)
      ? content.flatMap((item, index) =>
          typeof item === "object" && item !== null && Reflect.get(item, "type") === "image"
            ? [{ item, index }]
            : [],
        )
      : [];
    const imageOriginals = attachments.filter(
      (attachment) =>
        attachment.kind === "file" && attachment.inputReference?.mimeType.startsWith("image/"),
    );
    const pairedImages =
      imageBlocks.length > 0 && imageOriginals.length === imageBlocks.length
        ? new Map(imageOriginals.map((attachment, index) => [attachment, imageBlocks[index]!]))
        : undefined;
    const imagePart = (
      { item, index }: { item: object; index: number },
      name: string,
      inputReference?: TaskInputReference,
    ): UiPart => {
      const data = Reflect.get(item, "data");
      return {
        id: `${baseId}-attachment-${index}`,
        kind: "attachment",
        name,
        ...(inputReference ? { inputReference } : null),
        mediaType: String(Reflect.get(item, "mimeType") ?? "image").slice(0, 128),
        attachmentKind: "image",
        data: typeof data === "string" && data.length <= 20_000_000 ? data : undefined,
      };
    };
    attachments.forEach((attachment, index) => {
      const pairedImage = pairedImages?.get(attachment);
      if (pairedImage && attachment.kind === "file") {
        parts.push(imagePart(pairedImage, attachment.name, attachment.inputReference));
        return;
      }
      if (attachment.kind === "input" || attachment.kind === "file") {
        parts.push({
          id: `${baseId}-input-${index}`,
          kind: "attachment",
          name: attachment.name,
          inputReference: attachment.kind === "input" ? attachment : attachment.inputReference,
          mediaType: attachment.kind === "input" ? attachment.mimeType : "application/octet-stream",
          attachmentKind: "file",
        });
        return;
      }
      if (attachment.kind === "annotation") {
        parts.push({
          id: `${baseId}-annotation-${index}`,
          kind: "annotation",
          annotations: attachment.annotations,
        });
        return;
      }
      if (attachment.kind === "browser") {
        parts.push({
          id: `${baseId}-browser-attachment-${index}`,
          kind: "attachment",
          name: attachment.name,
          mediaType: "text/html",
          attachmentKind: "browser",
          url: attachment.url,
          tagName: attachment.tagName,
          selector: attachment.selector,
          outerHTML: attachment.outerHTML,
          browserText: attachment.text,
        });
        return;
      }
      parts.push({
        id: `${baseId}-source-attachment-${index}`,
        kind: "attachment",
        name: attachment.name,
        mediaType: "text/plain",
        attachmentKind: "source",
        location: attachment.location,
        ...(attachment.selectedText !== undefined
          ? { selectedText: attachment.selectedText }
          : null),
        ...(attachment.comment !== undefined ? { comment: attachment.comment } : null),
      });
    });
    if (!pairedImages)
      for (const block of imageBlocks) parts.push(imagePart(block, `Image ${block.index + 1}`));
    if (
      entryId &&
      parts.length > 0 &&
      !parts.some((part) => (part.kind === "text" && part.role === "user") || part.kind === "skill")
    )
      parts.unshift({
        id: `${baseId}-text`,
        kind: "text",
        role: "user",
        entryId,
        renderKey,
        text: "",
        status: "complete",
      });
    // Sender-authored FYIs and remaining context precede the actual user input in every view.
    return [...reminderParts, ...passiveNoticeParts(internal), ...parts];
  }

  if (role === "assistant" && Array.isArray(content)) {
    const usage = Reflect.get(message, "usage");
    const requestedAt = Reflect.get(message, "timestamp");
    const provider = Reflect.get(message, "provider");
    const modelId = Reflect.get(message, "model");
    const retention: "short" | "long" =
      process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
    const tokenCount = (key: string) => {
      const value =
        typeof usage === "object" && usage !== null ? Reflect.get(usage, key) : undefined;
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    };
    let response =
      !streaming &&
      Reflect.get(message, "stopReason") !== "error" &&
      Reflect.get(message, "stopReason") !== "aborted" &&
      typeof requestedAt === "number" &&
      Number.isFinite(requestedAt) &&
      requestedAt >= 0 &&
      typeof provider === "string" &&
      provider.length > 0 &&
      typeof modelId === "string" &&
      modelId.length > 0
        ? {
            provider: provider.slice(0, 256),
            modelId: modelId.slice(0, 512),
            retention,
            requestedAt,
            inputTokens: tokenCount("input"),
            cacheReadTokens: tokenCount("cacheRead"),
            cacheWriteTokens: tokenCount("cacheWrite"),
          }
        : undefined;
    const stopReason = Reflect.get(message, "stopReason");
    // A send-now handoff also hides the `error` a run can end with when the abort lands
    // between a cancelled tool and the next request: the handoff caused it.
    const deliberateAbort =
      (stopReason === "aborted" && abortPresentation.kind !== "interrupted") ||
      (stopReason === "error" && abortPresentation.kind === "handoff");
    const takeResponse = () => {
      const current = response;
      response = undefined;
      return current;
    };
    const parts = content.flatMap((item, index): UiPart[] => {
      if (typeof item !== "object" || item === null) return [];
      const type = Reflect.get(item, "type");
      if (type === "text") {
        const text = String(Reflect.get(item, "text") ?? "");
        if (!text) return [];
        const sources = [...new Set(text.match(/https?:\/\/[^\s)\]}>,]+/g) ?? [])]
          .filter((url) => url.length <= 8_192)
          .slice(0, 20);
        return [
          {
            id: `${baseId}-text-${index}`,
            kind: "text",
            role: "assistant",
            entryId,
            // Live parts use stream ids and settled parts use entry ids. Pi keeps
            // the assistant message timestamp from stream start through
            // persistence, so it lets the renderer keep one mounted message
            // (and any open fullscreen view) across the settled snapshot.
            renderKey:
              typeof requestedAt === "number" && Number.isFinite(requestedAt)
                ? `assistant-${requestedAt}-text-${index}`
                : undefined,
            // Unlike `response`, every text part carries this, even after reasoning or tools.
            requestedAt:
              typeof requestedAt === "number" && Number.isFinite(requestedAt) && requestedAt >= 0
                ? requestedAt
                : undefined,
            text,
            status: streaming
              ? "streaming"
              : Reflect.get(message, "errorMessage") && !deliberateAbort
                ? "error"
                : "complete",
            response: takeResponse(),
          },
          ...sources.map((url, sourceIndex): UiPart => ({
            id: `${baseId}-source-${index}-${sourceIndex}`,
            kind: "source",
            title: sourceTitle(url),
            url,
          })),
        ];
      }
      if (type === "thinking") {
        return [
          {
            // Keep the observed reasoning clock when stream ids become entry ids.
            // The request timestamp identifies the block; it is not its start time.
            id:
              typeof requestedAt === "number" && Number.isFinite(requestedAt)
                ? `reasoning-${requestedAt}-${index}`
                : `${baseId}-reasoning-${index}`,
            kind: "reasoning",
            text: String(Reflect.get(item, "thinking") ?? ""),
            status: streaming && index === streamingContentIndex ? "streaming" : "complete",
            response: takeResponse(),
          },
        ];
      }
      if (type === "toolCall") {
        const name = String(Reflect.get(item, "name") ?? "tool");
        const args = Reflect.get(item, "arguments");
        return [
          {
            id: boundedProjectionKey(`tool-${String(Reflect.get(item, "id"))}`),
            kind: "tool",
            name,
            command: name === "cake" ? cakeOperationCommand(args) : undefined,
            input: formatToolInput(name, args),
            artifactId: toolArtifactId(args),
            filePath: toolFilePath(name, args),
            inputStreaming: index === streamingContentIndex,
            state: "running",
            response: takeResponse(),
          },
        ];
      }
      return [];
    });
    if (
      !streaming &&
      Reflect.get(message, "stopReason") === "aborted" &&
      abortPresentation.kind === "stopped"
    ) {
      parts.push({
        id: `${baseId}-stopped`,
        kind: "notice",
        tone: "info",
        title: TURN_STOPPED_NOTICE_TITLE,
        detail: capitalize(describeTurnStop(abortPresentation.stop)),
      });
      return parts;
    }
    const errorMessage = Reflect.get(message, "errorMessage");
    if (
      !deliberateAbort &&
      !parts.some((part) => part.kind === "text") &&
      typeof errorMessage === "string" &&
      errorMessage.trim()
    ) {
      parts.push({
        id: `${baseId}-error`,
        kind: "notice",
        tone: "error",
        title: "Model request failed",
        detail: errorMessage.trim(),
      });
    }
    return parts;
  }

  if (role === "toolResult") {
    const name = String(Reflect.get(message, "toolName") ?? "tool");
    const details = Reflect.get(message, "details");
    const timing = Schema.decodeUnknownOption(
      Schema.Struct({
        durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        timestamp: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      }),
    )(message);
    // Durable has no regular-Pi custom entries. Its original tool result is the
    // presentation authority, including on a page without the assistant tool call.
    const presentation =
      name === "cake" && !Reflect.get(message, "isError")
        ? Schema.decodeUnknownOption(
            Schema.Struct({
              command: Schema.Literals(["artifacts.present", "html.present"]),
              result: ArtifactProjectionMetadata,
            }),
          )(details)
        : Option.none();
    const messagePresentation =
      name === "cake" && !Reflect.get(message, "isError")
        ? Schema.decodeUnknownOption(
            Schema.Struct({ command: Schema.Literal("messages.present"), result: MessageMetadata }),
          )(details)
        : Option.none();
    const part: Extract<UiPart, { kind: "tool" }> = {
      id: boundedProjectionKey(`tool-${String(Reflect.get(message, "toolCallId"))}`),
      kind: "tool",
      name,
      command: name === "cake" ? cakeOperationCommand({ details }) : undefined,
      input: "",
      output: textFromContent(content) || formatUnknown(details),
      outputContent: projectToolOutputContent(content),
      nestedCalls: projectNestedToolCalls(Reflect.get(message, "nestedCalls")),
      artifactId: Option.isSome(presentation)
        ? presentation.value.result.lineageId
        : toolArtifactId({ details }),
      artifactRevision: Option.isSome(presentation)
        ? presentation.value.result.selectedRevision
        : toolArtifactRevision({ details }),
      ...(Option.isSome(presentation)
        ? { artifactReference: presentation.value.result.exactRef }
        : null),
      ...(Option.isSome(messagePresentation)
        ? { messageReference: messagePresentation.value.result.ref }
        : null),
      diff: toolResultDiff(name, { details }),
      state: Reflect.get(message, "isError") ? "error" : "success",
    };
    if (Option.isSome(timing))
      return [
        {
          ...part,
          durationMs: timing.value.durationMs,
          startedAt: Math.max(0, timing.value.timestamp - timing.value.durationMs),
        },
      ];
    return [part];
  }

  if (role === "bashExecution") {
    const exitCode = Reflect.get(message, "exitCode");
    const cancelled = Reflect.get(message, "cancelled") === true;
    return [
      shellCommandPart({
        id: `${baseId}-bash`,
        command: String(Reflect.get(message, "command") ?? ""),
        output: String(Reflect.get(message, "output") ?? ""),
        excludeFromContext: Reflect.get(message, "excludeFromContext") === true,
        state: cancelled || (typeof exitCode === "number" && exitCode !== 0) ? "error" : "success",
      }),
    ];
  }

  if (role === "custom") {
    // Recovery is an execution trigger, not a conversational context disclosure.
    if (
      Reflect.get(message, "customType") === "cake.restart-recovery" &&
      Reflect.get(message, "display") === false
    )
      return [];
    return [
      {
        id: `${baseId}-custom`,
        kind: "context",
        title: String(Reflect.get(message, "customType") ?? "System message"),
        text: textFromContent(content),
      },
    ];
  }
  return [];
}

export function createLiveMessageProjector(
  options: {
    deferProviderErrors?: boolean;
    abortPresentation?(): AbortPresentation;
    currentSystemPrompt?(): string;
    currentSystemTools?(): readonly Tool[];
    initialSystemMessages?: readonly unknown[];
    renderUserMessageAsMarkdown?(message: unknown): boolean;
    internalInput?(content: string): InternalInput | undefined;
  } = {},
) {
  const projectSystem = createSystemContextProjector(options.initialSystemMessages);
  let hasSystemContext =
    options.initialSystemMessages?.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        Reflect.get(message, "role") === "system",
    ) ?? false;
  let activeStreamId: string | undefined;
  let streamingContentIndex: number | undefined;
  let streamIndex = 0;
  let userIndex = 0;
  let activeAssistantPartIds = new Set<string>();
  let lastAssistantPartIds: string[] = [];

  const nextStreamId = () => `stream-${++streamIndex}`;
  const project = (event: AgentSessionEvent): UiPart[] => {
    if (event.type === "message_start" && event.message.role === "user") {
      const content = textFromContent(event.message.content);
      const internal = options.internalInput?.(content);
      if (internal?._tag === "WorkboardDelivery")
        return [internalInputPart(internal, `live-user-${++userIndex}-context`)];
      if (internal?._tag === "SubagentCompletion")
        return [subagentCompletionPart(`live-user-${++userIndex}-custom`, content)];
      return partsFromMessage(
        event.message,
        `live-user-${++userIndex}`,
        false,
        undefined,
        options.renderUserMessageAsMarkdown?.(event.message) ?? false,
        undefined,
        interruptedAbort,
        internal,
      );
    }
    if (
      event.type === "message_start" &&
      (event.message.role === "custom" || event.message.role === "system")
    ) {
      const baseId = `live-context-${++userIndex}`;
      const initialSystemContext = event.message.role === "system" && !hasSystemContext;
      if (event.message.role === "system") hasSystemContext = true;
      const parts =
        event.message.role === "system"
          ? projectSystem(event.message, baseId, textFromContent(event.message.content))
          : partsFromMessage(event.message, baseId);
      // Named-section deduplication handles established context. Comparing every
      // patch with the current prompt would hide genuine full replacements.
      return initialSystemContext && options.currentSystemPrompt
        ? withoutRuntimeSystemPrompt(
            parts,
            options.currentSystemPrompt(),
            options.currentSystemTools?.(),
          )
        : parts;
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      activeStreamId = nextStreamId();
      streamingContentIndex = undefined;
      activeAssistantPartIds = new Set();
      return [];
    }
    if (event.type === "message_update") {
      activeStreamId ??= nextStreamId();
      const update = event.assistantMessageEvent;
      streamingContentIndex =
        update.type === "toolcall_start" ||
        update.type === "toolcall_delta" ||
        update.type === "thinking_start" ||
        update.type === "thinking_delta"
          ? update.contentIndex
          : undefined;
      const parts = partsFromMessage(
        event.message,
        activeStreamId,
        true,
        undefined,
        false,
        streamingContentIndex,
      );
      for (const part of parts) activeAssistantPartIds.add(part.id);
      return parts;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      activeStreamId ??= nextStreamId();
      // Pi decides whether an error will retry immediately after message_end.
      // Defer its final live projection until the settled snapshot so an
      // intermediate failure never flashes in the transcript.
      const parts =
        options.deferProviderErrors && event.message.stopReason === "error"
          ? []
          : partsFromMessage(
              event.message,
              activeStreamId,
              false,
              undefined,
              false,
              undefined,
              options.abortPresentation?.() ?? interruptedAbort,
            );
      for (const part of parts) activeAssistantPartIds.add(part.id);
      lastAssistantPartIds = [...activeAssistantPartIds];
      activeAssistantPartIds = new Set();
      activeStreamId = undefined;
      streamingContentIndex = undefined;
      return parts;
    }
    return [];
  };
  project.streamingParts = (message: unknown): UiPart[] => {
    if (!activeStreamId) return [];
    const parts = partsFromMessage(
      message,
      activeStreamId,
      true,
      undefined,
      false,
      streamingContentIndex,
    );
    for (const part of parts) activeAssistantPartIds.add(part.id);
    return parts;
  };
  project.takeLastAssistantPartIds = () => {
    const partIds = lastAssistantPartIds;
    lastAssistantPartIds = [];
    return partIds;
  };
  return project;
}

function sourceTitle(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "Source";
  }
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
