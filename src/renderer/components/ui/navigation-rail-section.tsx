import { useContext, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { NavigationRailLabelsContext } from "./navigation-rail-labels";

/**
 * Small grey section label with an optional trailing action. The icon-only rail keeps
 * the action centred in the icon column (or a hairline without one). The element tree is
 * identical in both widths so a focused action survives label disclosure.
 */
export function NavigationRailSection({ label, action }: { label: string; action?: ReactNode }) {
  const labelsVisible = useContext(NavigationRailLabelsContext) !== false;
  return (
    <div
      data-slot="navigation-rail-section"
      className="relative flex h-7 min-w-0 shrink-0 items-center px-1"
    >
      {/* The scroll region already carries this name; avoid announcing it twice. */}
      <span
        aria-hidden="true"
        className={cn(
          "min-w-0 flex-1 truncate pl-3 text-xs font-medium text-muted-foreground",
          !labelsVisible && "invisible",
        )}
      >
        {label}
      </span>
      {!action && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-1 top-1/2 ml-3 h-px w-5 bg-border",
            labelsVisible && "invisible",
          )}
        />
      )}
      {action && (
        <span
          className={cn(
            "grid place-items-center",
            labelsVisible ? "pr-1.5" : "absolute inset-y-0 left-1 w-11",
          )}
        >
          {action}
        </span>
      )}
    </div>
  );
}
