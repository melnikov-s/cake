import { Slider } from "./slider";

/** A labeled numeric setting with an accessible explanation and formatted value. */
export function SettingSlider({
  id,
  label,
  description,
  scopeLabel,
  value,
  valueText,
  min,
  max,
  step,
  minLabel,
  maxLabel,
  onValueChange,
}: {
  id: string;
  label: string;
  description: string;
  scopeLabel?: string;
  value: number;
  valueText: string;
  min: number;
  max: number;
  step: number;
  minLabel?: string;
  maxLabel?: string;
  onValueChange(value: number): void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="text-xs font-medium text-foreground">
          {label}
        </label>
        <p id={`${id}-description`} className="text-[11px] text-muted-foreground">
          {scopeLabel && <span className="sr-only">{scopeLabel}. </span>}
          {description}
        </p>
      </div>
      <div className="grid w-48 shrink-0 gap-1">
        <div className="flex items-center justify-end text-[11px]">
          <span className="tabular-nums font-medium text-foreground">{valueText}</span>
        </div>
        <Slider
          id={id}
          min={min}
          max={max}
          step={step}
          value={value}
          aria-describedby={`${id}-description`}
          aria-valuetext={valueText}
          onValueChange={onValueChange}
        />
        {(minLabel || maxLabel) && (
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{minLabel}</span>
            <span>{maxLabel}</span>
          </div>
        )}
      </div>
    </div>
  );
}
