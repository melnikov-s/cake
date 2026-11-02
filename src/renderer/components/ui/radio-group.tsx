import { useId } from "react";

/** Compact, native single-choice inputs with all options visible. */
export function RadioGroup<T extends string>({
  label,
  value,
  options,
  onValueChange,
  disabled,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onValueChange(value: T): void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-2">
      <legend className="text-xs font-medium">{label}</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {options.map((option) => (
          <label key={option.value} className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onValueChange(option.value)}
              className="peer size-3.5 shrink-0 appearance-none rounded-full border border-border bg-card checked:border-4 checked:border-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25 disabled:opacity-50"
            />
            <span className="peer-disabled:opacity-50">{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
