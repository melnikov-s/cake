import {
  parseSkillBlock,
  type AgentSessionEvent,
  type SessionEntry,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { Option, Schema } from "effect";
import { artifactPointerSchema, type ArtifactPointer } from "../../../ipc/artifact-contract";
import { parseCrossSessionMessage } from "../../../domain/cross-session-coordination";
import {
  attachmentSchema,
  toolOutputContentArraySchema,
  type Attachment,
  type SessionTreeEntry,
  type ToolOutputContent,
  type UiPart,
} from "../../../ipc/session-contract";

export const reviewRunEntryType = "cake.review-run/v1";
export const userMessagePresentationEntryType = "cake.user-message-presentation/v1";
export const userMessagePresentationEntrySchema = Schema.Struct({
  targetId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  renderAs: Schema.Literals(["markdown", "plain"]),
});
export type UserMessagePresentation = typeof userMessagePresentationEntrySchema.Type;
/** Marks the orientation preamble appended as the first entry of a handoff session. */
export const handoffEntryType = "cake.handoff/v1";
export const reviewRunEntrySchema = Schema.Struct({
  operationId: Schema.String.check(Schema.isUUID()),
  threadIds: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  commentCount: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000_000)),
  status: Schema.Literals(["running", "complete", "error"]),
});
export type ReviewRunEntry = typeof reviewRunEntrySchema.Type;

export function boundedProjectionKey(value: string, maximum = 256) {
  if (value.length <= maximum) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${value.slice(0, maximum - digest.length - 1)}:${digest}`;
}

export function formatUnknown(value: unknown, limit = 48_000) {
  let formatted: string;
  if (typeof value === "string") formatted = value;
  else {
    try {
      formatted = JSON.stringify(value, null, 2) ?? String(value ?? "");
    } catch {
      formatted = String(value);
    }
  }
  return formatted.length > limit ? `${formatted.slice(0, limit)}\n…` : formatted;
}

export function formatToolInput(toolName: string, args: unknown) {
  if (toolName === "bash" && typeof args === "object" && args !== null) {
    const command = Reflect.get(args, "command");
    if (typeof command === "string") return formatUnknown(command);
  }
  return formatUnknown(args);
}

export function shellCommandPart(input: {
  id: string;
  command: string;
  output: string;
  excludeFromContext: boolean;
  state: Extract<UiPart, { kind: "command" }>["state"];
}): Extract<UiPart, { kind: "command" }> {
  return { kind: "command", ...input };
}

function parseToolOutputContent(content: unknown) {
  const parsed = Schema.decodeUnknownOption(toolOutputContentArraySchema)(content);
  return Option.isSome(parsed) && parsed.value.length > 0 ? parsed.value : undefined;
}

function projectToolOutputContent(content: unknown): ToolOutputContent[] | undefined {
  const parsed = parseToolOutputContent(content);
  return parsed?.some((item) => item.type !== "text") ? [...parsed] : undefined;
}

export function toolResultContent(result: unknown) {
  if (typeof result !== "object" || result === null) return undefined;
  return parseToolOutputContent(Reflect.get(result, "content"));
}

export function toolResultOutputContent(result: unknown) {
  const content = toolResultContent(result);
  return content?.some((item) => item.type !== "text") ? [...content] : undefined;
}

export function formatToolResult(result: unknown) {
  const content = toolResultContent(result);
  return content ? textFromContent(content) : formatUnknown(result);
}

export function toolFilePath(_toolName: string, args: unknown) {
  if (typeof args !== "object" || args === null) return undefined;
  const path = Reflect.get(args, "path") ?? Reflect.get(args, "file_path");
  return typeof path === "string" && path.length <= 8_192 ? path : undefined;
}

export function toolResultDiff(_toolName: string, result: unknown) {
  if (typeof result !== "object" || result === null) return undefined;
  const details = Reflect.get(result, "details");
  if (typeof details !== "object" || details === null) return undefined;
  const diff = Reflect.get(details, "diff") ?? Reflect.get(details, "patch");
  return typeof diff === "string" ? diff : undefined;
}

export function cakeOperationCommand(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined;
  const direct = Reflect.get(value, "command");
  if (typeof direct === "string" && direct.length <= 256) return direct;
  const details = Reflect.get(value, "details");
  if (typeof details === "object" && details !== null) {
    const command = Reflect.get(details, "command");
    if (typeof command === "string" && command.length <= 256) return command;
  }
  return undefined;
}

export function toolArtifactId(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined;
  const direct = Reflect.get(value, "artifactId");
  if (typeof direct === "string") return direct;
  const details = Reflect.get(value, "details");
  const detailedId =
    typeof details === "object" && details !== null
      ? Reflect.get(details, "artifactId")
      : undefined;
  if (typeof detailedId === "string") return detailedId;
  const result =
    typeof details === "object" && details !== null ? Reflect.get(details, "result") : undefined;
  const resultId =
    typeof result === "object" && result !== null ? Reflect.get(result, "artifactId") : undefined;
  if (typeof resultId === "string") return resultId;
  const artifact = Reflect.get(value, "artifact");
  const artifactId =
    typeof artifact === "object" && artifact !== null ? Reflect.get(artifact, "id") : undefined;
  if (typeof artifactId === "string") return artifactId;
  const request = Reflect.get(value, "request");
  const requestId =
    typeof request === "object" && request !== null ? Reflect.get(request, "id") : undefined;
  return typeof requestId === "string" ? requestId : undefined;
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        Reflect.get(item, "type") === "text" &&
        typeof Reflect.get(item, "text") === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

const sourceAttachmentPattern =
  /(?:^|\n)<cake-source-attachment>(.*?)<\/cake-source-attachment>(?:\n|$)/gs;
const annotationAttachmentPattern = /(?:^|\n)<cake-annotations>(.*?)<\/cake-annotations>(?:\n|$)/gs;

function parseContextAttachmentBlocks(text: string) {
  const attachments: Extract<Attachment, { kind: "source" | "annotation" }>[] = [];
  const withoutSources = text.replace(sourceAttachmentPattern, (_match, encoded: string) => {
    try {
      const parsed = Schema.decodeUnknownOption(attachmentSchema)(JSON.parse(encoded));
      if (Option.isNone(parsed) || parsed.value.kind !== "source") return _match;
      attachments.push(parsed.value);
      return "\n";
    } catch {
      return _match;
    }
  });
  const visibleText = withoutSources.replace(
    annotationAttachmentPattern,
    (_match, encoded: string) => {
      try {
        const parsed = Schema.decodeUnknownOption(attachmentSchema)(JSON.parse(encoded));
        if (Option.isNone(parsed) || parsed.value.kind !== "annotation") return _match;
        attachments.push(parsed.value);
        return "\n";
      } catch {
        return _match;
      }
    },
  );
  return { text: visibleText.trim(), attachments };
}

function partsFromMessage(
  message: unknown,
  baseId: string,
  streaming = false,
  entryId?: string,
  renderUserMessageAsMarkdown = false,
): UiPart[] {
  if (typeof message !== "object" || message === null) return [];
  const role = Reflect.get(message, "role");
  const content = Reflect.get(message, "content");

  if (role === "user") {
    const parts: UiPart[] = [];
    const crossSession = parseCrossSessionMessage(textFromContent(content));
    const parsedContext = parseContextAttachmentBlocks(
      crossSession?.text ?? textFromContent(content),
    );
    const text = parsedContext.text;
    const skill = parseSkillBlock(text);
    if (skill) {
      parts.push({
        id: `${baseId}-skill`,
        kind: "skill",
        entryId,
        name: skill.name,
        content: skill.content,
      });
      if (skill.userMessage)
        parts.push({
          id: `${baseId}-text`,
          kind: "text",
          role: "user",
          entryId,
          text: skill.userMessage,
          status: "complete",
          renderAs: renderUserMessageAsMarkdown ? "markdown" : undefined,
          crossSession: crossSession?.metadata,
        });
    } else if (text)
      parts.push({
        id: `${baseId}-text`,
        kind: "text",
        role: "user",
        entryId,
        text,
        status: "complete",
        renderAs: renderUserMessageAsMarkdown ? "markdown" : undefined,
        crossSession: crossSession?.metadata,
      });
    parsedContext.attachments.forEach((attachment, index) => {
      if (attachment.kind === "annotation") {
        parts.push({
          id: `${baseId}-annotation-${index}`,
          kind: "annotation",
          annotations: attachment.annotations,
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
      });
    });
    if (Array.isArray(content)) {
      content.forEach((item, index) => {
        if (typeof item === "object" && item !== null && Reflect.get(item, "type") === "image") {
          const data = Reflect.get(item, "data");
          parts.push({
            id: `${baseId}-attachment-${index}`,
            kind: "attachment",
            name: `Image ${index + 1}`,
            mediaType: String(Reflect.get(item, "mimeType") ?? "image").slice(0, 128),
            attachmentKind: "image",
            data: typeof data === "string" && data.length <= 20_000_000 ? data : undefined,
          });
        }
      });
    }
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
        text: "",
        status: "complete",
      });
    return parts;
  }

  if (role === "assistant" && Array.isArray(content)) {
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
            text,
            status: streaming
              ? "streaming"
              : Reflect.get(message, "errorMessage")
                ? "error"
                : "complete",
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
            id: `${baseId}-reasoning-${index}`,
            kind: "reasoning",
            text: String(Reflect.get(item, "thinking") ?? ""),
            status: streaming ? "streaming" : "complete",
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
            state: "running",
          },
        ];
      }
      return [];
    });
    const errorMessage = Reflect.get(message, "errorMessage");
    if (
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
    return [
      {
        id: boundedProjectionKey(`tool-${String(Reflect.get(message, "toolCallId"))}`),
        kind: "tool",
        name,
        command: name === "cake" ? cakeOperationCommand({ details }) : undefined,
        input: "",
        output: textFromContent(content) || formatUnknown(details),
        outputContent: projectToolOutputContent(content),
        artifactId: toolArtifactId({ details }),
        diff: toolResultDiff(name, { details }),
        state: Reflect.get(message, "isError") ? "error" : "success",
      },
    ];
  }

  // Live subagent activity already updates the handle-keyed surface. The full
  // snapshot folds this hidden completion into its original background start.
  if (role === "custom" && Reflect.get(message, "customType") === "cake.subagent-completion")
    return [];

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

  if (role === "custom" && Reflect.get(message, "display") === true) {
    return [
      {
        id: `${baseId}-custom`,
        kind: "notice",
        tone: "info",
        title: String(Reflect.get(message, "customType") ?? "Extension"),
        detail: textFromContent(content),
      },
    ];
  }
  return [];
}

export function createLiveMessageProjector(
  options: {
    deferProviderErrors?: boolean;
    renderUserMessageAsMarkdown?(message: unknown): boolean;
  } = {},
) {
  let activeStreamId: string | undefined;
  let streamIndex = 0;
  let userIndex = 0;
  let activeAssistantPartIds = new Set<string>();
  let lastAssistantPartIds: string[] = [];

  const nextStreamId = () => `stream-${++streamIndex}`;
  const project = (event: AgentSessionEvent): UiPart[] => {
    if (event.type === "message_start" && event.message.role === "user") {
      return partsFromMessage(
        event.message,
        `live-user-${++userIndex}`,
        false,
        undefined,
        options.renderUserMessageAsMarkdown?.(event.message) ?? false,
      );
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      activeStreamId = nextStreamId();
      activeAssistantPartIds = new Set();
      return [];
    }
    if (event.type === "message_update") {
      activeStreamId ??= nextStreamId();
      const parts = partsFromMessage(event.message, activeStreamId, true);
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
          : partsFromMessage(event.message, activeStreamId);
      for (const part of parts) activeAssistantPartIds.add(part.id);
      lastAssistantPartIds = [...activeAssistantPartIds];
      activeAssistantPartIds = new Set();
      activeStreamId = undefined;
      return parts;
    }
    return [];
  };
  project.takeLastAssistantPartIds = () => {
    const partIds = lastAssistantPartIds;
    lastAssistantPartIds = [];
    return partIds;
  };
  return project;
}

export function reviewRunPart(run: ReviewRunEntry): Extract<UiPart, { kind: "review-run" }> {
  return { id: `review-run-${run.operationId}`, kind: "review-run", ...run };
}

export function projectQueuedMessages(
  steering: readonly string[],
  followUp: readonly string[],
  pending: readonly string[] = [],
): UiPart[] {
  const project = (
    idPrefix: string,
    deliveryState: "steering" | "queued",
    messages: readonly string[],
  ) => {
    const occurrences = new Map<string, number>();
    return messages.flatMap((text): UiPart[] => {
      if (!text) return [];
      const crossSession = parseCrossSessionMessage(text);
      const visibleText = crossSession?.text ?? text;
      const occurrence = (occurrences.get(text) ?? 0) + 1;
      occurrences.set(text, occurrence);
      const digest = createHash("sha256")
        .update(`${deliveryState}\0${text}`)
        .digest("hex")
        .slice(0, 24);
      return [
        {
          id: `${idPrefix}-${digest}-${occurrence}`,
          kind: "text",
          role: "user",
          text: visibleText,
          status: "complete",
          deliveryState,
          crossSession: crossSession?.metadata,
        },
      ];
    });
  };
  return [
    ...project("queued-steering", "steering", steering),
    ...project("queued-follow-up", "queued", followUp),
    ...project("queued-pending", "queued", pending),
  ];
}

export function projectSessionEntries(
  entries: readonly SessionEntry[],
  branchEntries: readonly SessionEntry[] = entries,
  options: { live?: boolean } = {},
) {
  const projected: UiPart[] = [];
  const indexes = new Map<string, number>();
  const append = (part: UiPart) => {
    const existingIndex = indexes.get(part.id);
    if (existingIndex === undefined) {
      indexes.set(part.id, projected.length);
      projected.push(part);
      return;
    }
    const existing = projected[existingIndex];
    projected[existingIndex] =
      existing?.kind === "tool" && part.kind === "tool"
        ? {
            ...existing,
            ...part,
            input: part.input || existing.input,
            filePath: part.filePath || existing.filePath,
          }
        : part;
  };

  const visibleRunIds = new Set(
    entries.flatMap((entry) => {
      if (entry.type !== "custom" || entry.customType !== reviewRunEntryType) return [];
      const run = Schema.decodeUnknownOption(reviewRunEntrySchema)(entry.data);
      return Option.isSome(run) ? [run.value.operationId] : [];
    }),
  );
  const compactedRuns = new Map<string, ReviewRunEntry>();
  for (const entry of branchEntries) {
    if (entry.type !== "custom" || entry.customType !== reviewRunEntryType) continue;
    const run = Schema.decodeUnknownOption(reviewRunEntrySchema)(entry.data);
    if (Option.isSome(run) && !visibleRunIds.has(run.value.operationId))
      compactedRuns.set(run.value.operationId, run.value);
  }
  for (const run of compactedRuns.values()) append(reviewRunPart(run));

  const userMessagePresentations = new Map<string, UserMessagePresentation["renderAs"]>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== userMessagePresentationEntryType) continue;
    const presentation = Schema.decodeUnknownOption(userMessagePresentationEntrySchema)(entry.data);
    if (Option.isSome(presentation))
      userMessagePresentations.set(presentation.value.targetId, presentation.value.renderAs);
  }

  const intermediateRetryErrors = new Set<string>();
  let nextContextRole: string | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.stopReason === "error" &&
      nextContextRole === "assistant"
    )
      intermediateRetryErrors.add(entry.id);
    if (entry.type === "message") nextContextRole = entry.message.role;
    else if (entry.type === "custom_message") nextContextRole = "custom";
  }

  for (const entry of entries) {
    if (entry.type === "message") {
      if (intermediateRetryErrors.has(entry.id)) continue;
      for (const part of partsFromMessage(
        entry.message,
        `entry-${entry.id}`,
        false,
        entry.id,
        userMessagePresentations.get(entry.id) === "markdown",
      ))
        append(part);
      continue;
    }
    if (entry.type === "compaction") {
      append({
        id: `entry-${entry.id}-compaction`,
        kind: "compaction",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
        firstKeptEntryId: entry.firstKeptEntryId,
      });
      continue;
    }
    if (entry.type === "custom_message") {
      if (entry.customType === "cake.subagent-completion") {
        const completion = Schema.decodeUnknownOption(
          Schema.Struct({ handleId: Schema.String.check(Schema.isUUID()) }),
        )(entry.details);
        const start = Option.isSome(completion)
          ? projected.findLast(
              (part): part is Extract<UiPart, { kind: "tool" }> =>
                part.kind === "tool" &&
                part.command === "subagents.start" &&
                (part.input.includes(completion.value.handleId) ||
                  part.output?.includes(completion.value.handleId) === true),
            )
          : undefined;
        if (start) {
          const index = projected.indexOf(start);
          projected[index] = { ...start, output: formatUnknown(entry.details) };
        } else
          append({
            id: `entry-${entry.id}-subagent-completion`,
            kind: "tool",
            name: "cake",
            command: "subagents.completion",
            input: "",
            output: formatUnknown(entry.details),
            state: "success",
          });
      } else if (entry.display)
        append({
          id: `entry-${entry.id}-custom`,
          kind: "notice",
          tone: "info",
          title: entry.customType === handoffEntryType ? "Handoff" : entry.customType,
          detail: textFromContent(entry.content),
        });
      continue;
    }
    if (entry.type !== "custom") continue;
    if (entry.customType === "cake.artifact/v1") {
      const pointer = Schema.decodeUnknownOption(artifactPointerSchema)(entry.data);
      if (
        Option.isSome(pointer) &&
        pointer.value.kind === "request" &&
        !projected.some(
          (part) => part.kind === "tool" && part.artifactId === pointer.value.artifactId,
        )
      )
        append({
          id: `entry-${entry.id}-artifact`,
          kind: "tool",
          name: "cake",
          command: "requests.open",
          input: "",
          artifactId: pointer.value.artifactId,
          state: "success",
        });
      continue;
    }
    if (entry.customType === reviewRunEntryType) {
      const run = Schema.decodeUnknownOption(reviewRunEntrySchema)(entry.data);
      if (Option.isSome(run)) append(reviewRunPart(run.value));
    }
  }
  // Durable entries are settled history. A tool call still marked "running"
  // after the full walk has no recorded result, which means the run was
  // interrupted before the tool settled. Only a live runtime may claim
  // "running"; restored or idle sessions must present a terminal state.
  if (!options.live)
    for (const [index, part] of projected.entries())
      if (part.kind === "tool" && part.state === "running")
        projected[index] = { ...part, state: "interrupted" };
  return projected;
}

export function imageContent(attachments: Attachment[]) {
  return attachments.flatMap((attachment) =>
    attachment.kind === "image"
      ? [{ type: "image" as const, data: attachment.data, mimeType: attachment.mimeType }]
      : [],
  );
}

export function promptText(text: string, attachments: Attachment[]) {
  const additions = attachments.flatMap((item) => {
    if (item.kind === "file") return [`@${item.path}`];
    const encoded = JSON.stringify(item).replaceAll("<", "\\u003c");
    if (item.kind === "source")
      return [`<cake-source-attachment>${encoded}</cake-source-attachment>`];
    if (item.kind === "annotation") return [`<cake-annotations>${encoded}</cake-annotations>`];
    return [];
  });
  return additions.length ? `${text}${text ? "\n\n" : ""}${additions.join("\n")}` : text;
}

function sourceTitle(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "Source";
  }
}

function entryPreview(entry: SessionEntry) {
  if (entry.type === "message") {
    const message = entry.message;
    const role = message.role;
    const text = ("content" in message ? textFromContent(message.content) : "")
      .replace(/[\n\t]+/g, " ")
      .trim();
    if (role === "user") return text.slice(0, 2_048);
    if (message.role === "assistant") {
      if (text) return text.slice(0, 2_048);
      if (message.stopReason === "aborted") return "(aborted)";
      if (message.errorMessage)
        return message.errorMessage
          .replace(/[\n\t]+/g, " ")
          .trim()
          .slice(0, 2_048);
      return "";
    }
    if (message.role === "toolResult") return `[${message.toolName}]`;
    if (message.role === "bashExecution") return `[bash]: ${message.command}`.slice(0, 2_048);
    return `[${role}]`;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary")
    return entry.summary.slice(0, 2_048);
  if (entry.type === "custom_message")
    return textFromContent(entry.content)
      .replace(/[\n\t]+/g, " ")
      .trim()
      .slice(0, 2_048);
  if (entry.type === "session_info") return (entry.name ?? "Session renamed").slice(0, 2_048);
  if (entry.type === "model_change") return `${entry.provider}/${entry.modelId}`;
  return entry.type.replaceAll("_", " ");
}

export function projectTree(sessionManager: SessionManager): SessionTreeEntry[] {
  const activeIds = new Set(sessionManager.getBranch().map((entry) => entry.id));
  const entries: SessionTreeEntry[] = [];
  const stack = [...sessionManager.getTree()].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    entries.push({
      id: node.entry.id,
      parentId: node.entry.parentId ?? undefined,
      type: node.entry.type,
      messageRole: node.entry.type === "message" ? node.entry.message.role : undefined,
      editorText:
        node.entry.type === "message" && node.entry.message.role === "user"
          ? textFromContent(node.entry.message.content)
          : undefined,
      label: node.label,
      preview: entryPreview(node.entry),
      active: activeIds.has(node.entry.id),
    });
    for (let index = node.children.length - 1; index >= 0; index -= 1)
      stack.push(node.children[index]!);
  }
  return entries;
}

export function projectArtifactPointers(sessionManager: SessionManager): ArtifactPointer[] {
  const pointers = new Map<string, ArtifactPointer>();
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "custom" || Reflect.get(entry, "customType") !== "cake.artifact/v1")
      continue;
    const parsed = Schema.decodeUnknownOption(artifactPointerSchema)(Reflect.get(entry, "data"));
    if (Option.isNone(parsed)) continue;
    const current = pointers.get(parsed.value.artifactId);
    if (!current || parsed.value.revision > current.revision)
      pointers.set(parsed.value.artifactId, parsed.value);
  }
  return [...pointers.values()];
}
