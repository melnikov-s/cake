import { useEffect, useState } from "react";

export function SettingsTextField({ label, description, value, placeholder, onApply }: { label: string; description: string; value: string; placeholder?: string; onApply(value: string): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <label><span>{label}<small>{description}</small></span><input className="settings-input" value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft !== value) onApply(draft); }} /></label>;
}
