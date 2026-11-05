import { Schema } from "effect";
import { ExplicitCakeModelSelection } from "./cake-model-selection";

export const ModelReferenceSelection = ExplicitCakeModelSelection.pipe(
  Schema.fieldsAssign({
    presetName: Schema.optionalKey(Schema.String),
  }),
);
export interface ModelReferenceSelection extends Schema.Schema.Type<
  typeof ModelReferenceSelection
> {}

/** Message text, not an instruction to change the current session or launch an agent. */
export function serializeModelReference(model: ModelReferenceSelection): string {
  return `<cake-model>${JSON.stringify(model).replaceAll("<", "\\u003c")}</cake-model>`;
}

export interface ModelReferenceSegment {
  text: string;
  start: number;
  end: number;
  model?: ModelReferenceSelection;
}

/** Invalid/ordinary text stays literal. Offsets always address the original message. */
export function splitModelReferences(text: string): ModelReferenceSegment[] {
  const segments: ModelReferenceSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/<cake-model>([^\n]*?)<\/cake-model>/g)) {
    let model: ModelReferenceSelection;
    try {
      const value: unknown = JSON.parse(match[1]!);
      if (!Schema.is(ModelReferenceSelection)(value)) continue;
      model = value;
    } catch {
      continue;
    }
    const start = match.index;
    if (start > cursor)
      segments.push({ text: text.slice(cursor, start), start: cursor, end: start });
    cursor = start + match[0].length;
    segments.push({ text: match[0], start, end: cursor, model });
  }
  if (cursor < text.length)
    segments.push({ text: text.slice(cursor), start: cursor, end: text.length });
  return segments;
}

export function modelReferenceLabel(model: ModelReferenceSelection): string {
  return `${model.presetName ?? model.modelId} · ${model.thinkingLevel}${model.fastMode ? " · Fast" : ""}`;
}
