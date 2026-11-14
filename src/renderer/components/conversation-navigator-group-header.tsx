import { useId } from "react";
import type { SessionActivity } from "../lib/session-activity";
import { cn } from "../lib/utils";
import { SessionActivityIndicator, sessionActivityLabel } from "./session-activity-indicator";
import { Button } from "./ui/button";
import { ChevronIcon } from "./ui/icons";

/**
 * Collapsible Sessions group header: label, a quiet count and, while collapsed,
 * the most urgent hidden row state in the same column as row status dots.
 */
export function ConversationNavigatorGroupHeader({
  label,
  count,
  expanded,
  hiddenActivity,
  onToggle,
}: {
  label: string;
  count: number | undefined;
  expanded: boolean;
  hiddenActivity?: SessionActivity;
  onToggle(): void;
}) {
  const descriptionId = useId();
  const activity = expanded ? undefined : hiddenActivity;
  return (
    <div className="mt-2 flex items-center">
      <h3 className="min-w-0 flex-1">
        <Button
          variant="ghost"
          size="sm"
          className="w-full min-w-0 justify-start gap-1 pr-0.5"
          iconSize="inline"
          aria-label={label}
          aria-describedby={count === undefined && !activity ? undefined : descriptionId}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span className={cn("shrink-0", !expanded && "-rotate-90")}>
            <ChevronIcon />
          </span>
          <span className="min-w-0 truncate">{label}</span>
          {count !== undefined && (
            <span
              data-slot="group-count"
              aria-hidden="true"
              className="font-normal tabular-nums text-muted-foreground/70"
            >
              {count}
            </span>
          )}
          {activity && (
            <span className="ml-auto flex size-6 shrink-0 items-center justify-center">
              <SessionActivityIndicator activity={activity} />
            </span>
          )}
        </Button>
        <span id={descriptionId} hidden>
          {[
            count === undefined ? undefined : `${count} ${count === 1 ? "session" : "sessions"}`,
            activity && sessionActivityLabel(activity),
          ]
            .filter(Boolean)
            .join(", ")}
        </span>
      </h3>
    </div>
  );
}
