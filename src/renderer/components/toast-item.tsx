import { useState } from "react";
import { Button } from "./ui/button";
import { Callout } from "./ui/callout";
import { DisclosureTrigger } from "./ui/disclosure-trigger";
import { IconButton } from "./ui/icon-button";
import { CloseIcon } from "./ui/icons";
import { CopyErrorDetailsButton } from "./copy-error-details-button";
import type { Toast } from "../stores/ToastStore";

export function ToastItem({
  toast,
  onAction,
  onDismiss,
}: {
  toast: Toast;
  onAction(): void;
  onDismiss(): void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <Callout
      variant={toast.tone === "error" ? "error" : toast.tone === "warning" ? "warning" : "default"}
      className="relative shadow-lg"
      role={toast.tone === "error" ? "alert" : "status"}
    >
      <strong className="pr-7">{toast.title}</strong>
      <IconButton
        className="absolute right-1.5 top-1.5 size-7"
        tooltip="Dismiss notification"
        onClick={onDismiss}
      >
        <CloseIcon size={15} />
      </IconButton>
      <span className="pr-5 text-muted-foreground">{toast.message}</span>
      {toast.details && (
        <div className="mt-0.5 grid gap-1.5">
          <DisclosureTrigger
            className="text-muted-foreground"
            open={detailsOpen}
            title="Technical details"
            onClick={() => setDetailsOpen((open) => !open)}
          />
          {detailsOpen && (
            <>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background px-2.5 py-2 text-xs leading-normal">
                {toast.details}
              </pre>
              <CopyErrorDetailsButton details={toast.details} />
            </>
          )}
        </div>
      )}
      {toast.action && (
        <Button className="mt-0.5 w-fit" size="sm" variant="ghost" onClick={onAction}>
          {toast.action.label}
        </Button>
      )}
    </Callout>
  );
}
