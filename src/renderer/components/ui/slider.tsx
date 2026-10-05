import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface SliderProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "onChange"
> {
  onValueChange(value: number): void;
  onValueCommit?(): void;
}

export function Slider({ className, onValueChange, onValueCommit, ...props }: SliderProps) {
  return (
    <input
      {...props}
      type="range"
      className={cn(
        "h-5 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
        className,
      )}
      onChange={(event) => onValueChange(event.currentTarget.valueAsNumber)}
      onPointerUp={onValueCommit}
      onKeyUp={onValueCommit}
      onBlur={onValueCommit}
    />
  );
}
