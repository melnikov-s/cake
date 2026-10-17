import { useEffect, useState } from "react";
import { Input } from "../ui/input";

export function SettingsTextField({
  id,
  label,
  description,
  value,
  placeholder,
  onApply,
}: {
  id?: string;
  label: string;
  description: string;
  value: string;
  placeholder?: string;
  onApply(value: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label
      id={id}
      className="scroll-mt-8 flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm max-[620px]:flex-col max-[620px]:items-stretch"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <strong className="text-xs font-medium text-foreground">{label}</strong>
        <small className="text-[11px] text-muted-foreground">{description}</small>
      </span>
      <Input
        className="h-8 w-56 rounded-sm font-mono text-xs max-[620px]:w-full"
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
