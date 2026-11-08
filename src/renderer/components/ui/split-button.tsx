import type { ReactNode, Ref } from "react";
import { Button } from "./button";
import { Popover, PopoverContent, PopoverIconTrigger } from "./popover";
import { ChevronDownIcon } from "./icons";

/** One repeatable action and a separately named configuration menu. */
export function SplitButton({
  label,
  onClick,
  menuLabel,
  disabled,
  children,
  menuOpen,
  onMenuOpenChange,
  actionRef,
}: {
  label: string;
  onClick(): void;
  menuLabel: string;
  disabled?: boolean;
  children: ReactNode;
  actionRef?: Ref<HTMLButtonElement>;
  menuOpen?: boolean;
  onMenuOpenChange?(open: boolean): void;
}) {
  return (
    <div className="inline-flex">
      <Button
        ref={actionRef}
        size="sm"
        variant="outline"
        className="rounded-r-none"
        onClick={onClick}
        disabled={disabled}
      >
        {label}
      </Button>
      <Popover open={menuOpen} onOpenChange={onMenuOpenChange}>
        <PopoverIconTrigger
          tooltip={menuLabel}
          className="h-7 rounded-l-none border border-l-0 border-border bg-card px-1.5 shadow-2xs"
          disabled={disabled}
        >
          <ChevronDownIcon />
        </PopoverIconTrigger>
        <PopoverContent align="start" className="w-72 p-3">
          {children}
        </PopoverContent>
      </Popover>
    </div>
  );
}
