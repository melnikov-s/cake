import { useEffect, useState } from "react";
import { piSettingsSchema, type PiSettings } from "../../../ipc/session-contract";
import { Button } from "../ui/button";

export function SettingsPackagesField({ value, onApply }: { value: PiSettings["packages"]; onApply(value: PiSettings["packages"]): void }) {
  const serialized = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string>();
  useEffect(() => { setDraft(serialized); setError(undefined); }, [serialized]);
  const apply = () => {
    try {
      onApply(piSettingsSchema.shape.packages.parse(JSON.parse(draft)));
      setError(undefined);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };
  return <label className="settings-multiline"><span>Packages<small>Pi package sources as JSON. Saving reloads every open Pi session.</small>{error && <small className="settings-validation" role="alert">{error}</small>}</span><span className="settings-editor"><textarea aria-label="Pi packages" value={draft} rows={6} onChange={(event) => setDraft(event.target.value)} /><Button variant="outline" size="sm" type="button" onClick={apply}>Apply</Button></span></label>;
}
