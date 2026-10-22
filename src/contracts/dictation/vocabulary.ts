import { Schema } from "effect";
import { AgentListInput, agentListPage } from "../agent/agent-list-data";

const phrase = Schema.Trim.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(80),
  Schema.isPattern(/^[^\p{Cc}\p{Cf}]+$/u),
);
export const VocabularyWord = Schema.Struct({
  text: phrase,
  aliases: Schema.Array(phrase).check(Schema.isMaxLength(5)),
});
export interface VocabularyWord extends Schema.Schema.Type<typeof VocabularyWord> {}
export function parseVocabularyWord(input: VocabularyWord): VocabularyWord | undefined {
  const result = Schema.decodeUnknownResult(VocabularyWord)(input);
  return result._tag === "Success" ? result.success : undefined;
}
export const VocabularyEntry = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ...VocabularyWord.fields,
});
export interface VocabularyEntry extends Schema.Schema.Type<typeof VocabularyEntry> {}
export const DictationVocabulary = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  entries: Schema.Array(VocabularyEntry).check(Schema.isMaxLength(100)),
}).check(
  Schema.makeFilter((value) => {
    const ids = value.entries.map((entry) => entry.id);
    const forms = value.entries.flatMap((entry) => [entry.text, ...entry.aliases].map(key));
    return new Set(ids).size === ids.length && new Set(forms).size === forms.length;
  }),
);
export interface DictationVocabulary extends Schema.Schema.Type<typeof DictationVocabulary> {}
export const emptyVocabulary = (): DictationVocabulary => ({ revision: 0, entries: [] });
export const VocabularyChange = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("add"),
    expectedRevision: DictationVocabulary.fields.revision,
    ...VocabularyWord.fields,
  }),
  Schema.Struct({
    action: Schema.Literal("update"),
    expectedRevision: DictationVocabulary.fields.revision,
    ...VocabularyEntry.fields,
  }),
  Schema.Struct({
    action: Schema.Literal("remove"),
    expectedRevision: DictationVocabulary.fields.revision,
    id: VocabularyEntry.fields.id,
  }),
]);
export type VocabularyChange = typeof VocabularyChange.Type;
export const VocabularyListInput = Schema.Struct({
  ...AgentListInput.fields,
});
export const VocabularyPage = Schema.Struct({
  revision: DictationVocabulary.fields.revision,
  entries: Schema.Array(VocabularyEntry),
  total: Schema.Int,
  nextOffset: Schema.NullOr(Schema.Int),
});

const normalize = (text: string) => text.normalize("NFKC").trim().replace(/\s+/gu, " ");
const key = (text: string) => normalize(text).toLowerCase();

/** One mutation against one revision; aliases discover candidates, never text substitutions. */
export function changeVocabulary(
  current: DictationVocabulary,
  change: VocabularyChange,
  newId: string,
): DictationVocabulary {
  if (change.expectedRevision !== current.revision)
    throw new Error("Vocabulary changed. Refresh and retry with the current revision.");
  if (change.action !== "add" && !current.entries.some((entry) => entry.id === change.id))
    throw new Error("Vocabulary entry not found. Refresh before editing.");
  if (change.action === "remove")
    return {
      revision: current.revision + 1,
      entries: current.entries.filter((entry) => entry.id !== change.id),
    };
  const word = parseVocabularyWord({
    text: normalize(change.text),
    aliases: change.aliases.map(normalize),
  });
  if (!word)
    throw new Error(
      "Use 3–80 characters per word or phrase and up to 5 aliases, without control characters.",
    );
  const { text, aliases } = word;
  const forms = [text, ...aliases].map(key);
  if (new Set(forms).size !== forms.length)
    throw new Error("Preferred spelling and aliases must be distinct (ignoring case and spacing).");
  const others = current.entries.filter(
    (entry) => change.action === "add" || entry.id !== change.id,
  );
  if (
    others.some((entry) => [entry.text, ...entry.aliases].some((form) => forms.includes(key(form))))
  )
    throw new Error("That word or alias already belongs to another vocabulary entry.");
  if (others.length >= 100) throw new Error("Vocabulary is limited to 100 entries.");
  return {
    revision: current.revision + 1,
    entries: [...others, { id: change.action === "add" ? newId : change.id, text, aliases }],
  };
}

export function listVocabulary(
  current: DictationVocabulary,
  input: typeof VocabularyListInput.Type,
) {
  const search = key(input.query ?? "");
  const entries = current.entries
    .filter((entry) => [entry.text, ...entry.aliases].some((form) => key(form).includes(search)))
    .sort((a, b) => key(a.text).localeCompare(key(b.text)) || a.id.localeCompare(b.id));
  const page = agentListPage(entries, input);
  return {
    revision: current.revision,
    entries: page.items,
    total: page.total,
    nextOffset: page.nextOffset,
  };
}
