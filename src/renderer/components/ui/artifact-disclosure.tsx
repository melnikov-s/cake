import { type ReactNode, useId } from "react";
import { DisclosureTrigger } from "./disclosure-trigger";

/** One collapsible inline artifact surface, with no separate open action. */
export function ArtifactDisclosure({
  title,
  reference,
  open,
  onToggle,
  children,
}: {
  title: string;
  reference: string;
  open: boolean;
  onToggle(): void;
  children?: ReactNode;
}) {
  const contentId = useId();
  return (
    <section
      className="min-w-0"
      data-slot="artifact-disclosure"
      data-artifact-reference={reference}
    >
      <div className="flex min-w-0 items-center gap-3 py-1">
        <DisclosureTrigger
          title={title}
          subtitle={open ? "Collapse" : "Expand"}
          open={open}
          aria-controls={open ? contentId : undefined}
          onClick={onToggle}
        />
      </div>
      {open && (
        <div id={contentId} className="min-w-0 pt-2">
          {children}
        </div>
      )}
    </section>
  );
}
