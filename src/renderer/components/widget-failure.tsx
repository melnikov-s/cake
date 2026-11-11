import { useState } from "react";
import { Callout } from "./ui/callout";
import { Button } from "./ui/button";

export function WidgetFailure({
  diagnostic,
  retry,
  repair,
}: {
  diagnostic: string;
  retry(): void;
  repair?: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Callout variant="error" role="alert">
      <strong>Widget stopped</strong>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs">
        {diagnostic}
      </pre>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={retry}>
          Retry
        </Button>
        {repair && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending || sent}
            onClick={() => {
              setPending(true);
              setError(undefined);
              void repair()
                .then(
                  () => setSent(true),
                  (cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : String(cause)),
                )
                .finally(() => setPending(false));
            }}
          >
            {pending ? "Sending…" : sent ? "Repair sent" : "Repair"}
          </Button>
        )}
      </div>
      {error && <p className="mt-2 text-xs">{error}</p>}
    </Callout>
  );
}
