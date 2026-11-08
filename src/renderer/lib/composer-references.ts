import { parseSessionLink } from "../../contracts/conversations/message-reference";
import {
  splitModelReferences,
  type ModelReferenceSegment,
} from "../../contracts/model-presets/model-reference";

export interface ComposerReferenceSegment extends ModelReferenceSegment {
  sessionId?: string;
}

/** Presentation only: every token and offset retains the original outgoing text. */
export function splitComposerReferences(text: string): ComposerReferenceSegment[] {
  return splitModelReferences(text).flatMap((part): ComposerReferenceSegment[] => {
    if (part.model) return [part];
    const segments: ComposerReferenceSegment[] = [];
    let cursor = 0;
    for (const match of part.text.matchAll(/\[[^\]\n]*\]\((cake:\/\/session\/[^)\s]+)\)/g)) {
      const target = parseSessionLink(match[1]!);
      if (!target || target.messageId || target.attachmentId) continue;
      const start = match.index;
      if (start > cursor)
        segments.push({
          text: part.text.slice(cursor, start),
          start: part.start + cursor,
          end: part.start + start,
        });
      cursor = start + match[0].length;
      segments.push({
        text: match[0],
        start: part.start + start,
        end: part.start + cursor,
        sessionId: target.sessionId,
      });
    }
    if (cursor < part.text.length)
      segments.push({
        text: part.text.slice(cursor),
        start: part.start + cursor,
        end: part.end,
      });
    return segments;
  });
}
