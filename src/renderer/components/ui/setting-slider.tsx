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
    <div className="@container min-w-0">
      <div className="grid min-w-0 gap-2 px-3.5 py-3 @min-[36rem]:grid-cols-[minmax(0,1fr)_12rem] @min-[36rem]:items-center @min-[36rem]:gap-6">
        <div className="flex min-w-0 flex-col gap-0.5">
          <label htmlFor={id} className="text-xs font-medium text-foreground">
            {label}
          </label>
          <p
            id={`${id}-description`}
            className="max-w-prose text-[11px] leading-relaxed text-muted-foreground"
          >
            {scopeLabel && <span className="sr-only">{scopeLabel}. </span>}
            {description}
          </p>
        </div>
        <div className="grid min-w-0 gap-1">
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
    </div>
  );
}
