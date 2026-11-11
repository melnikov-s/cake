import { Option, Schema } from "effect";
import {
  attachmentSchema,
  type Attachment,
  type UiPart,
} from "../../../contracts/conversations/session-contract";
import { parseCrossSessionMessage } from "../../../contracts/conversations/cross-session-message";
import { parseScheduledMessage } from "../../../contracts/conversations/scheduled-message-envelope";
import { splitContextReminders } from "./session-context-reminders";

const inputAttachmentPattern = /(?:^|\n)<cake-task-input>(.*?)<\/cake-task-input>(?=\n|$)/gs;
const fileAttachmentPattern =
  /(?:^|\n)<cake-file-attachment>(.*?)<\/cake-file-attachment>(?=\n|$)/gs;
const sourceAttachmentPattern =
  /(?:^|\n)<cake-source-attachment>(.*?)<\/cake-source-attachment>(?=\n|$)/gs;
const browserAttachmentPattern =
  /(?:^|\n)<cake-browser-attachment>(.*?)<\/cake-browser-attachment>(?=\n|$)/gs;
const annotationAttachmentPattern = /(?:^|\n)<cake-annotations>(.*?)<\/cake-annotations>(?=\n|$)/gs;
const widgetItemAttachmentPattern = /(?:^|\n)<cake-widget-item>(.*?)<\/cake-widget-item>(?=\n|$)/gs;
type ContextAttachmentKind = "source" | "browser" | "annotation" | "input" | "file" | "widget-item";

export function parseContextAttachmentBlocks(text: string) {
  const attachments: Extract<Attachment, { kind: ContextAttachmentKind }>[] = [];
  const parseBlocks = <Kind extends ContextAttachmentKind>(
    value: string,
    pattern: RegExp,
    kind: Kind,
  ) =>
    value.replace(pattern, (match, encoded: string) => {
      try {
        const parsed = Schema.decodeUnknownOption(attachmentSchema)(JSON.parse(encoded));
        if (Option.isNone(parsed) || parsed.value.kind !== kind) return match;
        const attachment = parsed.value;
        if (
          attachment.kind !== "source" &&
          attachment.kind !== "browser" &&
          attachment.kind !== "annotation" &&
          attachment.kind !== "input" &&
          attachment.kind !== "file" &&
          attachment.kind !== "widget-item"
        )
          return match;
        attachments.push(attachment);
        return "\n";
      } catch {
        return match;
      }
    });
  const withoutInputs = parseBlocks(text, inputAttachmentPattern, "input");
  const withoutFiles = parseBlocks(withoutInputs, fileAttachmentPattern, "file");
  const withoutSources = parseBlocks(withoutFiles, sourceAttachmentPattern, "source");
  const withoutBrowserAttachments = parseBlocks(
    withoutSources,
    browserAttachmentPattern,
    "browser",
  );
  const withoutAnnotations = parseBlocks(
    withoutBrowserAttachments,
    annotationAttachmentPattern,
    "annotation",
  );
  const visibleText = parseBlocks(withoutAnnotations, widgetItemAttachmentPattern, "widget-item");
  return { text: visibleText.trim(), attachments };
}

export function visibleUserMessageText(text: string) {
  return parseContextAttachmentBlocks(parseUserMessageEnvelope(text).text).text;
}

type UserMessageEnvelope = {
  readonly text: string;
  readonly crossSession?: Extract<UiPart, { kind: "text" }>["crossSession"];
  readonly scheduled?: Extract<UiPart, { kind: "text" }>["scheduled"];
};

/** Strips Cake's provenance envelope from a Pi user message and surfaces its metadata. */
export function parseUserMessageEnvelope(
  content: string,
  literalUserText = false,
): UserMessageEnvelope {
  if (literalUserText) return { text: content };
  content = splitContextReminders(content).text;
  const scheduled = parseScheduledMessage(content);
  if (scheduled) return { text: scheduled.text, scheduled: scheduled.origin };
  const crossSession = parseCrossSessionMessage(content);
  if (crossSession) return { text: crossSession.text, crossSession: crossSession.metadata };
  return { text: content };
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
    const encoded = JSON.stringify(item).replaceAll("<", "\\u003c");
    if (item.kind === "input") return [`<cake-task-input>${encoded}</cake-task-input>`];
    if (item.kind === "file") return [`<cake-file-attachment>${encoded}</cake-file-attachment>`];
    if (item.kind === "image" && item.originalPath !== undefined) {
      const original = JSON.stringify({
        kind: "file",
        name: item.name,
        path: item.originalPath,
        inputReference: item.inputReference,
      }).replaceAll("<", "\\u003c");
      return [`<cake-file-attachment>${original}</cake-file-attachment>`];
    }
    if (item.kind === "text" || item.kind === "forwarded-input")
      throw new Error("Task inputs must be admitted before prompt construction");
    if (item.kind === "source")
      return [`<cake-source-attachment>${encoded}</cake-source-attachment>`];
    if (item.kind === "browser")
      return [`<cake-browser-attachment>${encoded}</cake-browser-attachment>`];
    if (item.kind === "annotation") return [`<cake-annotations>${encoded}</cake-annotations>`];
    // Label, item ID, widget data and the host-filled widget origin reach the model as data.
    if (item.kind === "widget-item") return [`<cake-widget-item>${encoded}</cake-widget-item>`];
    return [];
  });
  return additions.length ? `${text}${text ? "\n\n" : ""}${additions.join("\n")}` : text;
}
