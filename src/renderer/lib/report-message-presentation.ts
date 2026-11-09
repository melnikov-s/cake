import { Option, Schema } from "effect";

// A display projection, deliberately not the executable sessions.send contract.
const decodeSendEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({ command: Schema.Literal("sessions.send"), input: Schema.Unknown }),
  { onExcessProperty: "error" },
);
const decodeSendText = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }));

export interface ReportMessagePresentation {
  readonly body: string;
  readonly raw?: string;
  readonly extracted?: boolean;
}

/** Display only. Never dispatch, validate execution, or derive lifecycle facts from text.
 * Recognize only an entire bare Cake payload, optionally preceded by one heading.
 * Fences, inline code, indented code, and prose containing examples stay untouched. */
export function reportMessagePresentation(text: string): ReportMessagePresentation {
  const match = /^(?:(#{1,6} [^\n]+|\*\*[^\n]+\*\*)\r?\n+)?cake[ \t]+(\{[\s\S]*)$/.exec(text);
  if (!match || !/^\{\s*"command"\s*:/.test(match[2]!)) return { body: text };
  const heading = match[1] ? `${match[1]}\n\n` : "";
  try {
    // Execution results/errors are not send envelopes; never project them away.
    const envelope = decodeSendEnvelope(JSON.parse(match[2]!));
    const value = Option.flatMap(envelope, (send) => decodeSendText(send.input));
    if (Option.isSome(value) && value.value.text.trim()) {
      return { body: heading + value.value.text, raw: text, extracted: true };
    }
  } catch {
    // Broken/truncated JSON is still inspectable, not silently discarded.
  }
  return {
    body: "Tool-shaped report text could not be displayed as an update. View technical details for the original. This text is not evidence that a command ran.",
    raw: text,
  };
}
