import { Option, Schema } from "effect";
import type { Message } from "@earendil-works/pi-durable-ai";
import { attachmentSchema, type Attachment } from "../../contracts/conversations/session-contract";
import { promptText } from "../pi/runtime/session-projection";

const Presentation = Schema.Struct({
  textLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  markdown: Schema.Boolean,
  steering: Schema.optionalKey(Schema.Boolean),
  files: Schema.Array(attachmentSchema),
  imageNames: Schema.Array(Schema.String),
});
const prefix = /^<cake-input-presentation>([^\n]*)<\/cake-input-presentation>\n/;

/** Tiny admission metadata travels with the SDK's durable queued content, not a
 * second history or a lifetime map. Selected source text remains in promptText's
 * existing attachment envelope; image bytes remain only in their image blocks. */
export function durableInputText(
  text: string,
  attachments: readonly Attachment[],
  markdown: boolean,
  steering = false,
) {
  const metadata = {
    textLength: text.length,
    markdown,
    steering,
    files: attachments.filter((item) => item.kind === "file"),
    imageNames: attachments.flatMap((item) => (item.kind === "image" ? [item.name] : [])),
  };
  return `<cake-input-presentation>${JSON.stringify(metadata).replaceAll("<", "\\u003c")}</cake-input-presentation>\n${promptText(text, [...attachments])}`;
}

export function durableInputPresentation(value: string) {
  const match = prefix.exec(value);
  if (match) {
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Presentation))(match[1]);
    if (Option.isSome(decoded)) {
      const body = value.slice(match[0].length);
      return {
        body,
        text: body.slice(0, decoded.value.textLength),
        markdown: decoded.value.markdown,
        steering: decoded.value.steering ?? false,
        files: decoded.value.files,
        imageNames: decoded.value.imageNames,
      };
    }
  }
  // Synthetic memory/clock user blocks are ordinary SDK messages, not inputs.
  return { body: value, text: value, markdown: false, steering: false, files: [], imageNames: [] };
}

export function markDurableInputSteering(value: string, steering = true): string {
  const input = durableInputPresentation(value);
  const metadata = {
    textLength: input.text.length,
    markdown: input.markdown,
    steering,
    files: input.files,
    imageNames: input.imageNames,
  };
  return `<cake-input-presentation>${JSON.stringify(metadata).replaceAll("<", "\\u003c")}</cake-input-presentation>\n${input.body}`;
}

export function withoutDurableInputPresentation(message: Message): Message {
  if (message.role !== "user") return message;
  return {
    ...message,
    content:
      typeof message.content === "string"
        ? durableInputPresentation(message.content).body
        : message.content.map((block) =>
            block.type === "text"
              ? { ...block, text: durableInputPresentation(block.text).body }
              : block,
          ),
  };
}
