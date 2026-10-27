import { Option, Schema } from "effect";
import { InternalInput, withoutPassiveNotices } from "../../contracts/conversations/internal-input";
import {
  isAutomaticInput,
  passiveNoticeParts,
  queuedAutomaticInputPart,
} from "../pi/runtime/internal-input-projection";
import type { Message } from "@earendil-works/pi-durable-ai";
import {
  attachmentSchema,
  type Attachment,
  type UiPart,
} from "../../contracts/conversations/session-contract";
import type { InboxItem } from "@earendil-works/pi-durable";
import {
  parseContextAttachmentBlocks,
  promptText,
  queuedUserMessageDisplay,
} from "../pi/runtime/session-projection";
import { splitContextReminders } from "../pi/runtime/session-context-reminders";
import { ProjectSessionPresentationMode } from "../../contracts/project-sessions/project-session-presentation";
import { addPresentationModeReminder } from "../../contracts/conversations/presentation-mode-reminders";

import { SubagentReportOrigin } from "../../contracts/subagents/subagent-data";
import {
  addResponseModeReminder,
  ConversationResponseMode,
} from "../../contracts/conversations/response-mode-reminders";

const Presentation = Schema.Struct({
  textLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Start of the original user text, after any injected presentation reminder. */
  textOffset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  markdown: Schema.Boolean,
  internal: Schema.optionalKey(InternalInput),
  steering: Schema.optionalKey(Schema.Boolean),
  files: Schema.Array(attachmentSchema),
  imageNames: Schema.Array(Schema.String),
  subagentReport: Schema.optionalKey(SubagentReportOrigin),
  /** Effective response mode of this input; absent on inputs admitted before voice support. */
  responseMode: Schema.optionalKey(ConversationResponseMode),
  presentationMode: Schema.optionalKey(ProjectSessionPresentationMode),
});
const prefix = /^<cake-input-presentation>([^\n]*)<\/cake-input-presentation>\n/;

/** Response mode recorded with an input, and whether its model text carries the transition reminder. */
export interface DurableInputResponse {
  readonly mode: ConversationResponseMode;
  readonly remind: boolean;
}

/** Tiny admission metadata travels with the SDK's durable queued content, not a
 * second history or a lifetime map. Selected source text remains in promptText's
 * existing attachment envelope; image bytes remain only in their image blocks.
 * Recorded presentation/response modes let the next admission find the previous
 * modes from the newest Cake input, so restart recovery needs no second store. */
export function durableInputText(
  text: string,
  attachments: readonly Attachment[],
  markdown: boolean,
  steering = false,
  subagentReport?: SubagentReportOrigin,
  response: DurableInputResponse = { mode: "text", remind: false },
  internal?: InternalInput,
  presentation?: {
    readonly mode: ProjectSessionPresentationMode;
    readonly previousMode: ProjectSessionPresentationMode;
  },
) {
  const body = `${promptText(text, [...attachments])}${subagentReport ? `\n\nWorker provenance: ${JSON.stringify(subagentReport)}` : ""}`;
  const presented = presentation
    ? addPresentationModeReminder(body, presentation.previousMode, presentation.mode)
    : body;
  const metadata = {
    internal,
    subagentReport,
    textLength: text.length,
    textOffset: presented.length - body.length,
    markdown,
    steering,
    files: attachments.filter((item) => item.kind === "file"),
    imageNames: attachments.flatMap((item) => (item.kind === "image" ? [item.name] : [])),
    responseMode: response.mode,
    presentationMode: presentation?.mode ?? "normal",
  };
  // Presentation guidance starts the body; response guidance ends it. These are
  // the existing injection boundaries the shared projection reads as context pills.
  return `<cake-input-presentation>${JSON.stringify(metadata).replaceAll("<", "\\u003c")}</cake-input-presentation>\n${response.remind ? addResponseModeReminder(presented, response.mode) : presented}`;
}

export function durableInputPresentation(value: string) {
  const match = prefix.exec(value);
  if (match) {
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Presentation))(match[1]);
    if (Option.isSome(decoded)) {
      const body = value.slice(match[0].length);
      const textOffset = decoded.value.textOffset ?? 0;
      return {
        body,
        subagentReport: decoded.value.subagentReport,
        internal: decoded.value.internal,
        text: body.slice(textOffset, textOffset + decoded.value.textLength),
        textOffset,
        markdown: decoded.value.markdown,
        steering: decoded.value.steering ?? false,
        files: decoded.value.files,
        imageNames: decoded.value.imageNames,
        responseMode: decoded.value.responseMode ?? ("text" as const),
        presentationMode: decoded.value.presentationMode ?? ("normal" as const),
      };
    }
  }
  // Synthetic memory/clock user blocks are ordinary SDK messages, not inputs.
  return {
    body: value,
    text: value,
    textOffset: 0,
    markdown: false,
    steering: false,
    files: [],
    imageNames: [],
    subagentReport: undefined,
    internal: undefined,
    // Not a Cake input, so it carries no modes of its own.
    responseMode: undefined,
    presentationMode: undefined,
  };
}

export function markDurableInputSteering(value: string, steering = true): string {
  const input = durableInputPresentation(value);
  const metadata = {
    internal: input.internal,
    subagentReport: input.subagentReport,
    textLength: input.text.length,
    textOffset: input.textOffset,
    markdown: input.markdown,
    steering,
    files: input.files,
    imageNames: input.imageNames,
    responseMode: input.responseMode,
    presentationMode: input.presentationMode,
  };
  return `<cake-input-presentation>${JSON.stringify(metadata).replaceAll("<", "\\u003c")}</cake-input-presentation>\n${input.body}`;
}

export function withoutDurableInputPresentation(
  message: Message,
  options?: { display: true },
): Message {
  const body = (text: string) => {
    const input = durableInputPresentation(text);
    return options?.display && input.subagentReport ? input.text : input.body;
  };
  if (message.role !== "user") return message;
  return {
    ...message,
    content:
      typeof message.content === "string"
        ? body(message.content)
        : message.content.map((block) =>
            block.type === "text" ? { ...block, text: body(block.text) } : block,
          ),
  };
}

const SIDE_CHAT_NOTE_TAG = "<cake-side-chat>";

/**
 * Model-only orientation for a side chat forked from Cake Chat. It travels as its own
 * text block after the user's first side-chat input, so the forked prefix stays the
 * exact Cake Chat context and the side chat transcript never displays it.
 */
export const DURABLE_SIDE_CHAT_NOTE = `${SIDE_CHAT_NOTE_TAG}This is a side chat branched from Cake Chat at the message above. Cake Chat continues separately and never sees this side chat. Discuss the conversation with the user here. The cake tool is available here only for interview.open to ask the user questions; all other Cake actions require returning to Cake Chat.</cake-side-chat>`;

type Blocks = string | ReadonlyArray<{ type: string; text?: string }>;

const isSideChatNote = (block: { type: string; text?: string }) =>
  block.type === "text" && block.text?.startsWith(SIDE_CHAT_NOTE_TAG) === true;

/** Removes the model-only side-chat note from a user message for display. */
export function withoutDurableSideChatNote(message: Message): Message {
  if (message.role !== "user" || typeof message.content === "string") return message;
  return { ...message, content: message.content.filter((block) => !isSideChatNote(block)) };
}

const durableQueuedPresentation = (content: Blocks) =>
  durableInputPresentation(
    typeof content === "string"
      ? content
      : content
          .filter((part) => !isSideChatNote(part))
          .flatMap((part) => (part.text === undefined ? [] : [part.text]))
          .join("\n"),
  );

export const durableQueuedText = (content: Blocks) => durableQueuedPresentation(content).body;

/** Queued rows show the user's words, not Cake-owned model guidance such as a voice reminder. */
export const durableQueuedDisplayText = (content: Blocks) => {
  const input = durableQueuedPresentation(content);
  if (input.internal?._tag === "UserWithReminders" && input.internal.userText !== undefined)
    return input.internal.userText;
  if (input.internal?._tag === "AgentUpdate") return input.internal.update.text;
  return splitContextReminders(
    withoutPassiveNotices(
      durableQueuedPresentation(content).text,
      durableQueuedPresentation(content).internal,
    ),
  ).text;
};

/** One editable user queue card plus attributed FYIs; synthetic batch transport stays model-only. */
export function durableQueuedParts(
  item: Extract<InboxItem, { content: unknown }>,
  id: string,
): UiPart[] {
  const internal = durableQueuedPresentation(item.content).internal;
  const notices = isAutomaticInput(internal) ? [] : passiveNoticeParts(internal);
  const display = queuedUserMessageDisplay(
    durableQueuedDisplayText(item.content),
    internal?._tag === "UserWithReminders" && internal.userText !== undefined,
  );
  const { subagentReport } = durableQueuedPresentation(item.content);
  const row: Extract<UiPart, { kind: "text" }> = {
    id: `queued-${id}`,
    kind: "text",
    role: "user",
    ...display,
    status: "complete",
    deliveryState: item.mode === "steer" ? "steering" : "queued",
    ...(subagentReport ? { subagentReport } : null),
    queuedInput: {
      ...durableQueuedInput(item, id),
      ...(subagentReport ? { internal: "SubagentCompletion" as const } : null),
    },
  };
  return [...notices, isAutomaticInput(internal) ? queuedAutomaticInputPart(internal, row) : row];
}

/** The editable queued-input projection of one durable inbox item. */
const durableQueuedInput = (item: Extract<InboxItem, { content: unknown }>, id: string) => {
  const input = durableQueuedPresentation(item.content);
  const images =
    typeof item.content === "string"
      ? []
      : item.content
          .filter((block) => block.type === "image")
          .map((block, index) => ({
            kind: "image" as const,
            name: input.imageNames[index] ?? `Image ${index + 1}`,
            data: block.data,
            mimeType: block.mimeType,
          }));
  return {
    itemId: id,
    turnId: id,
    // Workflow reminders are model context, not editable user text.
    text: durableQueuedDisplayText(item.content),
    renderUserMessageAsMarkdown: input.markdown,
    attachments: [
      ...input.files,
      ...parseContextAttachmentBlocks(input.body).attachments,
      ...images,
    ],
  };
};
