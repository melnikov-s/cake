import { Schema } from "effect";
import { useEffect, useState } from "react";
import {
  piSettingsSchema,
  type PiSettings,
} from "../../../contracts/conversations/session-contract";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export function SettingsPackagesField({
  id,
  value,
  onApply,
}: {
  id?: string;
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
    <label id={id} className="scroll-mt-8 flex flex-col gap-2 px-3.5 py-2.5 text-sm">
      <div className="flex items-center justify-between gap-4">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="text-xs font-medium text-foreground">Packages</strong>
          <small className="text-[11px] text-muted-foreground">
            Pi package sources as JSON. Saving reloads open sessions.
          </small>
          {error && (
            <small className="mt-1 text-xs text-destructive" role="alert">
              {error}
            </small>
          )}
        </span>
        <Button variant="outline" size="sm" type="button" className="rounded-sm" onClick={apply}>
          Apply
        </Button>
      </div>
      <Textarea
        aria-label="Pi packages"
        className="min-h-20 w-full rounded-sm font-mono text-xs"
        value={draft}
        rows={4}
        onChange={(event) => setDraft(event.target.value)}
      />
    </label>
  );
}
