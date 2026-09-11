import { Fragment, useState } from "react";
import type { WorkflowStatusColor } from "../../../domain/application/application-data";
import { cn } from "../../lib/utils";
import { Avatar } from "./avatar";
import { Button } from "./button";
import { Popover, PopoverContent, PopoverIconTrigger } from "./popover";

export interface AvatarStatusPickerProps {
  seed: string;
  statuses: readonly {
    id: string;
    name: string;
    color: WorkflowStatusColor;
    scope?: "global" | "project";
  }[];
  value?: string;
  disabled?: boolean;
  animated?: boolean;
  className?: string;
  onChange(statusId?: string): void;
}

/** Session-avatar trigger and color-coded status menu. */
export function AvatarStatusPicker({
  seed,
  statuses,
  value,
  disabled = false,
  animated = false,
  className,
  onChange,
}: AvatarStatusPickerProps) {
  const [open, setOpen] = useState(false);
  const current = statuses.find((status) => status.id === value);
  const label = current?.name ?? "Unlabelled";
  const select = (statusId?: string) => {
    setOpen(false);
    onChange(statusId);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverIconTrigger
        className={cn("size-7 rounded-full p-0 hover:bg-muted", className)}
        tooltip={`Session status: ${label}`}
        ariaLabel={`Change session status. Current status: ${label}`}
        disabled={disabled}
      >
        <Avatar
          kind="session"
          seed={seed}
          statusColor={current?.color}
          animated={animated}
          className="size-6"
        />
      </PopoverIconTrigger>
      <PopoverContent
        align="start"
        side="right"
        className="max-h-[min(36rem,80vh)] w-56 overflow-y-auto p-2"
      >
        <p className="px-2 pb-1.5 text-[11px] font-semibold text-muted-foreground">
          Session status
        </p>
        <div className="grid gap-0.5" role="radiogroup" aria-label="Session status">
          <Button
            type="button"
            variant="ghost"
            className={cn(
              "h-9 justify-start gap-2 px-2 text-xs",
              value === undefined && "bg-muted text-foreground",
            )}
            role="radio"
            aria-checked={value === undefined}
            onClick={() => select(undefined)}
          >
            <Avatar kind="session" seed={seed} className="size-6" />
            <span>Unlabelled</span>
          </Button>
          {statuses.map((status, index) => {
            const previousScope = statuses[index - 1]?.scope;
            const showScope = status.scope !== undefined && status.scope !== previousScope;
            return (
              <Fragment key={status.id}>
                {showScope && (
                  <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/75">
                    {status.scope === "global" ? "Global" : "This project"}
                  </p>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(
                    "h-9 justify-start gap-2 px-2 text-xs",
                    value === status.id && "bg-muted text-foreground",
                  )}
                  role="radio"
                  aria-checked={value === status.id}
                  onClick={() => select(status.id)}
                >
                  <Avatar
                    kind="session"
                    seed={seed}
                    statusColor={status.color}
                    className="size-6"
                  />
                  <span className="truncate">{status.name}</span>
                </Button>
              </Fragment>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
