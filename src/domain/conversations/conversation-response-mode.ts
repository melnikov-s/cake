import { Schema } from "effect";

/** Captured at submission, including while Pi holds a queued input. Not a new session. */
export const ConversationResponseMode = Schema.Literals(["text", "voice"]);
export type ConversationResponseMode = typeof ConversationResponseMode.Type;

export const responseModeReminders = {
  voice: `<system-reminder>
Cake response mode: voice. You are in a spoken conversation in the existing session.
Reply briefly and naturally in plain spoken prose. Explain simply, and ask a short follow-up when useful.
Keep using the current model, context, skills and tools. Put code in fenced blocks and detailed tables in chat; do not recite them. Briefly tell the user when details are in chat.
Only assistant prose is spoken; thinking and tool output are not. Do not claim the user heard interrupted speech. Prefer a short answer first, with more detail on request.
</system-reminder>`,
  text: `<system-reminder>
Cake response mode: text. Use normal text-oriented replies; previous voice-mode guidance no longer applies to this input.
</system-reminder>`,
} as const;

/** Decorate model input only. Voice: brief plain spoken prose; code/details remain in chat.
 * Text explicitly restores normal response style, even after queued/reordered voice inputs.
 * Chat discloses the exact Cake-owned reminder as a context pill, separate from user text.
 * Title/editor projections omit it; Tool Compact removes it from replay, not original Pi history.
 */
export function addResponseModeReminder(text: string, mode: ConversationResponseMode): string {
  return `${text}${text ? "\n\n" : ""}${responseModeReminders[mode]}`;
}

// Pi appends these normalization hints after the decorated prompt, before persistence.
const imageHint =
  /^(?:\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by \d+\.\d{2} to map to original image\.\]|\[Image converted from [^\s\]]+ to [^\s\]]+\.\]|\[Image omitted: could not be (?:converted to a supported inline image format|resized below the inline image size limit)\.\])$/;

/** Remove only an exact Cake block at its boundary, including before Pi image hints. */
export function stripResponseModeReminder(text: string): string {
  for (const reminder of Object.values(responseModeReminders)) {
    const start = text.lastIndexOf(reminder);
    if (start < 0 || (start > 0 && text.slice(start - 2, start) !== "\n\n")) continue;
    const suffix = text.slice(start + reminder.length);
    if (
      suffix !== "" &&
      !(
        suffix.startsWith("\n\n") &&
        suffix
          .slice(2)
          .split("\n")
          .every((line) => imageHint.test(line))
      )
    )
      continue;
    const prefix = text.slice(0, start === 0 ? 0 : start - 2);
    return prefix ? prefix + suffix : suffix.replace(/^\n\n/, "");
  }
  return text;
}
