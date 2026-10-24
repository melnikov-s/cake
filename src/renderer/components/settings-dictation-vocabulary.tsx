import { useState } from "react";
import { observer } from "r-state-tree/react";
import { parseVocabularyWord } from "../../contracts/dictation/vocabulary";
import type { DictationStore } from "../stores/DictationStore";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Callout } from "./ui/callout";

export const SettingsDictationVocabulary = observer(function SettingsDictationVocabulary({
  store,
}: {
  store: DictationStore;
}) {
  const vocabulary = store.vocabulary;
  const page = vocabulary.page;
  const state = store.state;
  const [draft, setDraft] = useState<{
    id?: string;
    text: string;
    aliases: string;
    revision: number;
  }>();
  const [validation, setValidation] = useState<string>();
  const save = async () => {
    if (!draft) return;
    const word = {
      text: draft.text,
      aliases: draft.aliases.trim() ? draft.aliases.split(",").map((alias) => alias.trim()) : [],
    };
    const decoded = parseVocabularyWord(word);
    if (!decoded) {
      setValidation(
        "Use 3–80 characters per word or phrase and up to 5 comma-separated aliases. No control characters.",
      );
      return;
    }
    setValidation(undefined);
    const change = draft.id
      ? { action: "update" as const, id: draft.id, expectedRevision: draft.revision, ...decoded }
      : { action: "add" as const, expectedRevision: draft.revision, ...decoded };
    if (await vocabulary.change(change)) {
      setDraft(undefined);
      setValidation(undefined);
    }
  };
  return (
    <div id="setting-dictation-vocabulary" className="grid gap-3 px-3.5 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <h3 className="text-xs font-medium">Custom vocabulary</h3>
          <p className="text-xs text-muted-foreground">
            Preferred words and phrases for local acoustic recognition, including raw mode. No
            utility model or cloud transcription.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!page || !!draft || vocabulary.busy}
          onClick={() => {
            if (page) {
              setDraft({ text: "", aliases: "", revision: page.revision });
              setValidation(undefined);
            }
          }}
        >
          Add word
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Aliases are optional common misrecognitions, not automatic replacements. Audio must favor
        the preferred spelling; ordinary words can still be recognized. Changes apply to the next
        utterance (refocus the writing field).
      </p>
      {!state?.vocabularyInstalled ? (
        <div className="grid gap-2">
          <p className="text-xs text-muted-foreground">
            Saved words need an additional 103 MB CTC encoder download to become active. It runs an
            extra local inference pass per live revision, increasing latency and memory. First
            preparation can take several seconds before Listening. Empty vocabulary uses no extra
            model or inference.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="justify-self-start"
            disabled={
              !state?.supported ||
              !state.engineAvailable ||
              store.busy ||
              state.status === "installing"
            }
            onClick={() => void store.install(true)}
          >
            Download vocabulary encoder · 103 MB
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Local vocabulary encoder installed · {state.vocabularyCount} saved entries
        </p>
      )}
      <Input
        aria-label="Search custom vocabulary"
        placeholder="Search words and aliases…"
        value={vocabulary.query}
        onChange={(event) => vocabulary.search(event.target.value)}
      />
      {!page && !vocabulary.error && (
        <p className="text-xs text-muted-foreground" role="status">
          Loading vocabulary…
        </p>
      )}
      {page && page.entries.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {vocabulary.query
            ? "No matching words or aliases."
            : "No custom words yet. Add names or company terms you use."}
        </p>
      )}
      {page?.entries.map((entry) => (
        <div
          key={entry.id}
          className="flex items-center justify-between gap-3 border-b border-border/60 pb-2"
        >
          <div className="min-w-0 text-xs">
            <strong className="break-words font-medium">{entry.text}</strong>
            {entry.aliases.length > 0 && (
              <p className="break-words text-xs text-muted-foreground">
                Aliases: {entry.aliases.join(", ")}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-1">
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Edit ${entry.text}`}
              disabled={!!draft || vocabulary.busy}
              onClick={() => {
                setDraft({
                  id: entry.id,
                  text: entry.text,
                  aliases: entry.aliases.join(", "),
                  revision: page.revision,
                });
                setValidation(undefined);
              }}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove ${entry.text}`}
              disabled={!!draft || vocabulary.busy}
              onClick={() =>
                void vocabulary.change({
                  action: "remove",
                  id: entry.id,
                  expectedRevision: page.revision,
                })
              }
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
      {page && (vocabulary.offset > 0 || page.nextOffset !== null) && (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={vocabulary.offset === 0}
            onClick={() => vocabulary.go(Math.max(0, vocabulary.offset - 20))}
          >
            Previous words
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={page.nextOffset === null}
            onClick={() => {
              if (page.nextOffset !== null) vocabulary.go(page.nextOffset);
            }}
          >
            Next words
          </Button>
        </div>
      )}
      {draft && (
        <div className="grid gap-2 rounded-md border border-border p-3">
          <label className="grid gap-1 text-xs">
            Preferred spelling
            <Input
              disabled={vocabulary.busy}
              value={draft.text}
              maxLength={80}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            />
          </label>
          <label className="grid gap-1 text-xs">
            Aliases / common misrecognitions (optional)
            <Input
              disabled={vocabulary.busy}
              value={draft.aliases}
              placeholder="Comma-separated aliases"
              onChange={(event) => setDraft({ ...draft, aliases: event.target.value })}
            />
          </label>
          <div className="flex gap-2">
            <Button size="sm" disabled={vocabulary.busy} onClick={() => void save()}>
              Save word
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={vocabulary.busy}
              onClick={() => {
                setDraft(undefined);
                setValidation(undefined);
                void vocabulary.refresh();
              }}
            >
              Cancel word edit
            </Button>
          </div>
        </div>
      )}
      {(validation || vocabulary.error) && (
        <Callout variant="error">
          {validation ?? vocabulary.error}
          {vocabulary.error && !draft && (
            <Button size="sm" variant="outline" onClick={() => void vocabulary.refresh()}>
              Retry vocabulary
            </Button>
          )}
        </Callout>
      )}
    </div>
  );
});
