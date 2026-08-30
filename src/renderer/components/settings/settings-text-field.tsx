import { useEffect, useState } from "react";
import { Input } from "../ui/input";

export function SettingsTextField({
  label,
  description,
  value,
  placeholder,
  onApply,
}: {
  label: string;
  description: string;
  value: string;
  placeholder?: string;
  onApply(value: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="flex items-center justify-between gap-6 text-sm">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <strong className="text-xs font-medium text-foreground">{label}</strong>
        <small className="text-[11px] text-muted-foreground">{description}</small>
      </span>
      <Input
        className="h-8 max-w-md text-xs"
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) onApply(draft);
        }}
      />
    </label>
  );
}
