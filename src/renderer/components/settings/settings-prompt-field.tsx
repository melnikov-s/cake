import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export function SettingsPromptField({
  id,
  label,
  description,
  value,
  defaultValue,
  variables,
  onApply,
}: {
  id: string;
  label: string;
  description: string;
  value: string;
  defaultValue: string;
  variables?: string;
  onApply(value: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const changed = draft !== value;
  return (
    <section id={id} className="scroll-mt-8 grid gap-2 px-3.5 py-2.5">
      <div className="flex items-start justify-between gap-4">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="text-xs font-medium text-foreground">{label}</strong>
          <small className="text-xs text-muted-foreground">{description}</small>
          {variables && (
            <small className="font-mono text-xs text-muted-foreground">
              Variables: {variables}
            </small>
          )}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-sm"
          disabled={!draft}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setDraft("");
            if (value) onApply("");
          }}
        >
          Reset
        </Button>
      </div>
      <Textarea
        dictation
        aria-label={label}
        className="min-h-28 w-full rounded-sm font-mono text-xs"
        value={draft}
        placeholder={defaultValue}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (changed) onApply(draft);
        }}
      />
    </section>
  );
}
