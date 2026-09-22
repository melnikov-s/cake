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
  variables: string;
  onApply(value: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const changed = draft !== value;
  return (
    <section id={id} className="scroll-mt-8 rounded-md border border-border/70 p-4">
      <div className="mb-2 flex items-start justify-between gap-4">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="text-xs font-medium text-foreground">{label}</strong>
          <small className="text-[11px] text-muted-foreground">{description}</small>
          <small className="font-mono text-[10px] text-muted-foreground">
            Variables: {variables}
          </small>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={draft === defaultValue}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setDraft(defaultValue);
            if (value !== defaultValue) onApply(defaultValue);
          }}
        >
          Reset
        </Button>
      </div>
      <Textarea
        aria-label={label}
        className="min-h-36 w-full font-mono text-xs"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (changed) onApply(draft);
        }}
      />
    </section>
  );
}
