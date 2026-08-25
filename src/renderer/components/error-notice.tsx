import { useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { CloseIcon } from "@/components/ui/icons";
import { CopyErrorDetailsButton } from "./copy-error-details-button";

export function ErrorNotice({
  title,
  message,
  details = message,
}: {
  title: string;
  message: string;
  details?: string;
}) {
  const signature = `${title}\u0000${message}\u0000${details}`;
  const [dismissedSignature, setDismissedSignature] = useState<string>();
  if (dismissedSignature === signature) return null;

  return (
    <div
      className="relative grid gap-1 rounded-lg border-l-[3px] border-l-[color:var(--destructive)] bg-muted/65 px-4 py-3 text-[13px] leading-normal"
      role="alert"
    >
      <strong className="pr-8">{title}</strong>
      <IconButton
        className="absolute right-2 top-2"
        tooltip="Dismiss error"
        onClick={() => setDismissedSignature(signature)}
      >
        <CloseIcon size={16} />
      </IconButton>
      <span className="whitespace-pre-wrap text-muted-foreground">{message}</span>
      {details && details !== message && (
        <details>
          <summary className="cursor-pointer select-none text-muted-foreground">
            Technical details
          </summary>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background px-2.5 py-2 text-xs leading-normal">
            {details}
          </pre>
        </details>
      )}
      <CopyErrorDetailsButton details={details} />
    </div>
  );
}
