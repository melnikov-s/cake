import { useId, useState, type ComponentProps } from "react";
import { reportMessagePresentation } from "../lib/report-message-presentation";
import { Markdown } from "./ai-elements/markdown";
import { DisclosureTrigger } from "./ui/disclosure-trigger";

/** A report-only reading projection; the transcript and copy/source paths stay exact. */
export function ReportMessageBody({ children, ...props }: ComponentProps<typeof Markdown>) {
  const presentation = reportMessagePresentation(children);
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <Markdown {...props}>{presentation.body}</Markdown>
      {presentation.raw !== undefined && (
        <div className="min-w-0">
          {presentation.extracted && (
            <p className="mb-2 text-xs text-muted-foreground">
              Extracted message text · command execution not verified
            </p>
          )}
          <DisclosureTrigger
            title="View technical details"
            chevronPosition="start"
            className="w-fit rounded-md px-1.5 py-1 text-muted-foreground hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
            open={open}
            aria-controls={open ? id : undefined}
            onClick={() => setOpen(!open)}
          />
          {open && (
            <pre
              id={id}
              data-slot="report-raw-original"
              className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-3 font-mono text-xs"
            >
              {presentation.raw}
            </pre>
          )}
        </div>
      )}
    </>
  );
}
