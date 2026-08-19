import { useEffect, useState } from "react";

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
    <label className="settings-multiline">
      <span>
        {label}
        <small>{description}</small>
      </span>
      <textarea
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
