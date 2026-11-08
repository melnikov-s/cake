import { useId } from "react";
import { cn } from "@/lib/utils";

/** Compact, native single-choice inputs with all options visible. */
export function RadioGroup<T extends string>({
  label,
  value,
  options,
  onValueChange,
  disabled,
  variant = "inline",
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; description?: string }[];
  variant?: "inline" | "cards";
  onValueChange(value: T): void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-2">
      <legend className="text-xs font-medium">{label}</legend>
      <div className={cn(variant === "cards" ? "grid gap-2" : "flex flex-wrap gap-x-5 gap-y-2")}>
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex cursor-pointer gap-2.5 text-xs",
              variant === "cards" ? "items-start rounded-md border bg-card p-3" : "items-center",
              variant === "cards" &&
                (value === option.value ? "border-accent bg-accent/5" : "border-border/80"),
            )}
          >
            <input
              type="radio"
              aria-label={option.label}
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onValueChange(option.value)}
              className="peer mt-0.5 size-3.5 shrink-0 appearance-none rounded-full border border-border bg-card checked:border-4 checked:border-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25 disabled:opacity-50"
            />
            <span className="grid gap-1 peer-disabled:opacity-50">
              <span className="font-medium">{option.label}</span>
              {option.description && (
                <span className="leading-relaxed text-muted-foreground">{option.description}</span>
              )}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
