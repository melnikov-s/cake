import { useContext, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { IconButton } from "./icon-button";
import { NavigationRailLabelsContext } from "./navigation-rail-labels";

/**
 * Small grey section label, optionally acting as one full-row button. The icon-only rail
 * keeps the action centred in the icon column (or a hairline without one). The button
 * and its hit target survive label disclosure, including at the original hover location.
 */
export function NavigationRailSection({
  label,
  action,
}: {
  label: string;
  action?: { label: string; icon: ReactNode; onClick(): void };
}) {
  const labelsVisible = useContext(NavigationRailLabelsContext) !== false;
  // The scroll region already carries this name; avoid announcing it twice.
  const heading = (
    <span
      aria-hidden="true"
      className={cn(
        "w-full min-w-0 truncate pl-3 text-left text-xs font-medium text-muted-foreground",
        !labelsVisible && "invisible",
      )}
    >
      {label}
    </span>
  );
  return (
    <div
      data-slot="navigation-rail-section"
      className="relative flex h-7 min-w-0 shrink-0 items-center px-1"
    >
      {action ? (
        <IconButton
          tooltip={action.label}
          className="relative h-full w-full"
          onClick={action.onClick}
        >
          {heading}
          <span
            aria-hidden="true"
            className={cn(
              "absolute inset-y-0 grid place-items-center",
              labelsVisible ? "right-1.5 w-6" : "left-0 w-11",
            )}
          >
            {action.icon}
          </span>
        </IconButton>
      ) : (
        <>
          {heading}
          <span
            aria-hidden="true"
            className={cn(
              "absolute left-1 top-1/2 ml-3 h-px w-5 bg-border",
              labelsVisible && "invisible",
            )}
          />
        </>
      )}
    </div>
  );
}
