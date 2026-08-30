import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  instant?: boolean;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onCheckedChange, instant, className, disabled, onClick, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) {
          onCheckedChange?.(!checked);
        }
      }}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border border-border bg-background p-[2px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        checked && "border-accent bg-accent/20",
        instant && "transition-none",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-muted-foreground shadow-[0_1px_2px_oklch(0_0_0_/_0.18)] transition-transform",
          checked && "translate-x-4 bg-accent",
          instant && "transition-none",
        )}
      />
    </button>
  );
});
