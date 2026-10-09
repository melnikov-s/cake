import { type ReactNode, useId } from "react";
import { DisclosureTrigger } from "./disclosure-trigger";
import { Link } from "./link";

/** A compact artifact reference that can reveal its existing renderer in-place. */
export function ArtifactDisclosure({
  title,
  reference,
  open,
  onToggle,
  onOpen,
  children,
}: {
  title: string;
  reference: string;
  open: boolean;
  onToggle(): void;
  onOpen(): void;
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
          subtitle={open ? "Hide inline" : "Show inline"}
          open={open}
          aria-controls={open ? contentId : undefined}
          onClick={onToggle}
        />
        <Link
          className="shrink-0 text-xs"
          href={reference}
          onClick={(event) => {
            event.preventDefault();
            onOpen();
          }}
        >
          Open artifact
        </Link>
      </div>
      {open && (
        <div id={contentId} className="min-w-0 pt-2">
          {children}
        </div>
      )}
    </section>
  );
}
