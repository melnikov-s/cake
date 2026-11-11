import { useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { ChevronIcon } from "./icons";

export interface InsetDisclosureSection {
  id: string;
  label: string;
  count: number;
  icon: ReactNode;
  summary: ReactNode;
  /** Independent controls that remain available when the disclosure is collapsed. */
  actions?: ReactNode;
  accessibleLabel: string;
  accessibleDescription?: string;
  regionLabel: string;
  busy?: boolean;
  onOpen?(): void;
  renderContent(collapse: () => void): ReactNode;
}

/** Exclusive, non-dismissive disclosures attached to a composer. */
export function InsetDisclosures({ sections }: { sections: readonly InsetDisclosureSection[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const prefix = useId();
  const group = useRef<HTMLDivElement>(null);
  // Removed work must not reopen itself if it arrives again later.
  if (openId !== null && !sections.some((section) => section.id === openId)) setOpenId(null);

  return (
    <div
      ref={group}
      data-slot="inset-disclosures"
      className="w-full min-w-0"
      onKeyDown={(event) => {
        const headers = Array.from(
          group.current?.querySelectorAll<HTMLButtonElement>(
            '[data-slot="inset-disclosure-trigger"]',
          ) ?? [],
        );
        const index = headers.findIndex((header) => header === event.target);
        if (index >= 0 && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? headers.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + headers.length) % headers.length;
          headers[next]?.focus();
        }
        if (event.key === "Escape" && openId !== null) {
          event.preventDefault();
          event.stopPropagation();
          headers.find((header) => header.id === `${prefix}-${openId}-header`)?.focus();
          setOpenId(null);
        }
      }}
    >
      {sections.map((section) => {
        const open = section.id === openId;
        const headerId = `${prefix}-${section.id}-header`;
        const panelId = `${prefix}-${section.id}-panel`;
        return (
          <section key={section.id}>
            <div className="@container/inset-header flex min-w-0 flex-wrap items-center gap-x-1 pr-1.5">
              <h2 className="m-0 min-w-0 flex-1 text-xs font-medium">
                <Button
                  id={headerId}
                  data-slot="inset-disclosure-trigger"
                  data-section={section.id}
                  variant="ghost"
                  iconSize="inline"
                  className="h-8 w-full min-w-0 justify-start gap-1.5 rounded-sm px-2.5 text-xs font-medium text-foreground shadow-none"
                  aria-label={section.accessibleLabel}
                  aria-description={section.accessibleDescription}
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => {
                    if (!open) section.onOpen?.();
                    setOpenId(open ? null : section.id);
                  }}
                >
                  <ChevronIcon className={cn("shrink-0", !open && "-rotate-90")} />
                  <span aria-hidden="true" className="flex shrink-0 text-muted-foreground">
                    {section.icon}
                  </span>
                  <span>{section.label}</span>
                  <span className="min-w-[1.125rem] shrink-0 rounded-sm bg-muted px-1 text-center font-normal tabular-nums text-muted-foreground">
                    {section.count}
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "ml-auto flex shrink-0 items-center gap-2 font-normal tabular-nums text-muted-foreground",
                      section.actions && "@max-[360px]/inset-header:hidden",
                    )}
                  >
                    {section.summary}
                  </span>
                </Button>
              </h2>
              {section.actions}
            </div>
            <div
              id={panelId}
              role="region"
              aria-label={section.regionLabel}
              aria-busy={section.busy}
              hidden={!open}
              className={cn(
                "mr-2 mb-1.5 ml-[1.1875rem] max-h-[min(10.5rem,25vh)] min-w-0 overflow-y-auto overscroll-contain border-l border-border py-0.5 pl-1.5",
                !open && "hidden",
              )}
            >
              {section.renderContent(() => setOpenId(null))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
