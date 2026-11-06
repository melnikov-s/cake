import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { SpeechInputSettingsStore } from "../stores/SpeechInputSettingsStore";
import { validDiscardFilter } from "../../utils/speech-input-settings";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";

export const SettingsDictationDiscardFilters = observer(function SettingsDictationDiscardFilters({
  store,
}: {
  store: SpeechInputSettingsStore;
}) {
  const [text, setText] = useState("");
  const [matchCase, setMatchCase] = useState(true);
  const [editing, setEditing] = useState<number>();
  const reset = () => {
    setText("");
    setMatchCase(true);
    setEditing(undefined);
  };
  return (
    <div id="setting-dictation-discard-filters" className="grid gap-3 px-3.5 py-3">
      <h3 className="text-xs font-medium text-foreground">Discard standalone utterances</h3>
      <ul className="grid gap-2">
        {store.values.dictationDiscardFilters.map((filter, index) => (
          <li key={index} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 break-words text-xs">{filter.text}</span>
            <Switch
              aria-label={`Match case for ${filter.text}`}
              checked={filter.matchCase}
              onCheckedChange={(checked) =>
                store.editDiscardFilter(index, { ...filter, matchCase: checked })
              }
            />
            <span className="text-xs">Match case</span>
            <Button
              size="sm"
              variant="outline"
              aria-label={`Edit ${filter.text}`}
              onClick={() => {
                setEditing(index);
                setText(filter.text);
                setMatchCase(filter.matchCase);
              }}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove ${filter.text}`}
              onClick={() => {
                store.removeDiscardFilter(index);
                reset();
              }}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Discard phrase"
          className="min-w-0 flex-1"
          value={text}
          maxLength={256}
          onChange={(event) => setText(event.target.value)}
        />
        <Switch id="discard-filter-match-case" checked={matchCase} onCheckedChange={setMatchCase} />
        <label htmlFor="discard-filter-match-case" className="text-xs">
          Match case
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={!validDiscardFilter({ text, matchCase })}
          onClick={() => {
            if (editing === undefined) store.addDiscardFilter({ text, matchCase });
            else store.editDiscardFilter(editing, { text, matchCase });
            reset();
          }}
        >
          {editing === undefined ? "Add filter" : "Save filter"}
        </Button>
        {editing !== undefined && (
          <Button size="sm" variant="ghost" onClick={reset}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
});
