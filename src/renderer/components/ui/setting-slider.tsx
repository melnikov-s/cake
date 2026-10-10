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
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <label htmlFor={id} className="font-medium">
          {label}
        </label>
        <span className="shrink-0 tabular-nums text-muted-foreground">{valueText}</span>
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
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{minLabel}</span>
          <span>{maxLabel}</span>
        </div>
      )}
      <p id={`${id}-description`} className="text-xs text-muted-foreground">
        {scopeLabel && <span className="font-medium">{scopeLabel}. </span>}
        {description}
      </p>
    </div>
  );
}
