import { Schema } from "effect";
import { useEffect, useState } from "react";
import { piSettingsSchema, type PiSettings } from "../../../ipc/session-contract";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export function SettingsPackagesField({
  value,
  onApply,
}: {
  value: PiSettings["packages"];
  onApply(value: PiSettings["packages"]): void;
}) {
  const serialized = JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setDraft(serialized);
    setError(undefined);
  }, [serialized]);
  const apply = () => {
    try {
      onApply(Schema.decodeUnknownSync(piSettingsSchema.fields.packages)(JSON.parse(draft)));
      setError(undefined);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  };
  return (
    <label className="flex flex-col gap-2 text-sm">
      <span className="flex flex-col gap-0.5">
        <strong className="text-xs font-medium text-foreground">Packages</strong>
        <small className="text-[11px] text-muted-foreground">
          Pi package sources as JSON. Saving reloads every open Pi session.
        </small>
        {error && (
          <small className="mt-1 text-xs text-destructive" role="alert">
            {error}
          </small>
        )}
      </span>
      <div className="flex flex-col items-end gap-2">
        <Textarea
          aria-label="Pi packages"
          className="w-full font-mono text-xs"
          value={draft}
          rows={6}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button variant="outline" size="sm" type="button" onClick={apply}>
          Apply
        </Button>
      </div>
    </label>
  );
}
