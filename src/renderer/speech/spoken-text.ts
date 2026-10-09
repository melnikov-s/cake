import { stripPresentationModeReminder } from "../../domain/project-sessions/presentation-mode-reminders";
import { stripResponseModeReminder } from "../../domain/conversations/conversation-response-mode";

export interface SpokenPhrases {
  readonly phrases: readonly string[];
  readonly consumedCharacters: number;
}
const spoken = (text: string) =>
  stripResponseModeReminder(stripPresentationModeReminder(text))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-+]\s+|\d+\.\s+)/gm, "")
    .replace(/\s+/g, " ")
    .trim();

/** Scan cumulative raw text, including earlier fences, so offsets retain markup context. */
export function takeSpokenPhrases(
  text: string,
  consumedCharacters: number,
  final: boolean,
): SpokenPhrases {
  const phrases: string[] = [];
  const rawLength = text.length;
  text = stripResponseModeReminder(text);
  const withoutPresentation = stripPresentationModeReminder(text);
  const presentationOffset = text.length - withoutPresentation.length;
  let consumed = Math.max(presentationOffset, Math.min(consumedCharacters, text.length));
  let fence: { character: string; length: number } | undefined;
  let proseStart = consumed;
  const emit = (end: number) => {
    if (end <= consumed) return;
    const value = spoken(text.slice(Math.max(proseStart, consumed), end));
    for (let offset = 0; offset < value.length;) {
      let size = Math.min(2000, value.length - offset);
      if (size === 2000) {
        const space = value.lastIndexOf(" ", offset + size);
        if (space > offset) size = space - offset;
      }
      const phrase = value.slice(offset, offset + size).trim();
      if (phrase) phrases.push(phrase);
      offset += size;
    }
    consumed = end;
    proseStart = end;
  };
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf("\n", lineStart);
    const complete = newline >= 0;
    const end = complete ? newline + 1 : text.length;
    const line = text.slice(lineStart, end);
    const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    const marker = match?.[1];
    if (marker || fence) {
      if (lineStart >= consumed) emit(lineStart);
      if (!complete && !final) break;
      if (marker && match) {
        if (!fence) fence = { character: marker.charAt(0), length: marker.length };
        else if (
          marker[0] === fence.character &&
          marker.length >= fence.length &&
          line.slice(match[0].length).trim() === ""
        )
          fence = undefined;
      }
      if (end > consumed) {
        consumed = end;
        proseStart = end;
      }
    } else if (line.includes("|")) {
      if (!complete && !final) break;
      if (lineStart >= consumed) emit(lineStart);
      if (end > consumed) {
        consumed = end;
        proseStart = end;
      }
    } else if (end > consumed) {
      // Do not commit markup that could still be a fence, table, link or presentation tag.
      const rawStart = Math.max(lineStart, consumed);
      const raw = text.slice(rawStart, end);
      if (!complete && !final && (/^\s*[`~|]/.test(raw) || raw.includes("<system-reminder>")))
        break;
      let last = Math.max(lineStart, consumed);
      // Preserve clause context: commas/colons are model prosody, not requests.
      const boundary = /[.!?]["'”’)]*(?=\s|$)|\n/g;
      for (const match of raw.matchAll(boundary)) {
        const position = rawStart + (match.index ?? 0) + match[0].length;
        const fragment = text.slice(last, position);
        if (
          (fragment.match(/\[/g)?.length ?? 0) !== (fragment.match(/\]/g)?.length ?? 0) ||
          (fragment.match(/\(/g)?.length ?? 0) !== (fragment.match(/\)/g)?.length ?? 0)
        )
          continue;
        if (!complete && !final && position === text.length) continue;
        emit(position);
        last = position;
      }
      if (!final && end - consumed > 2000) {
        const space = text.lastIndexOf(" ", consumed + 2000);
        const fragment = text.slice(consumed, space);
        if (
          space > consumed &&
          !["[", "]", "(", ")", "<"].some((marker) => fragment.includes(marker))
        )
          emit(space);
      }
      if (final) emit(end);
    }
    lineStart = end;
  }
  return { phrases, consumedCharacters: final && consumed === text.length ? rawLength : consumed };
}
