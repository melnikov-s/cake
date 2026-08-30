import { useEffect, useState } from "react";
import { Textarea } from "../ui/textarea";

export function SettingsLinesField({
  label,
  description,
  value,
  onApply,
}: {
  label: string;
  description: string;
  value: string[];
  onApply(value: string[]): void;
}) {
  const serialized = value.join("\n");
  const [draft, setDraft] = useState(serialized);
  useEffect(() => setDraft(serialized), [serialized]);
  return (
    <label className="flex flex-col gap-2 text-sm">
      <span className="flex flex-col gap-0.5">
        <strong className="text-xs font-medium text-foreground">{label}</strong>
        <small className="text-[11px] text-muted-foreground">{description}</small>
      </span>
      <Textarea
        className="w-full font-mono text-xs"
        value={draft}
        rows={4}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = draft
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean);
          if (next.join("\n") !== serialized) onApply(next);
        }}
      />
    </label>
  );
}
