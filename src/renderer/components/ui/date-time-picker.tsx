import { useId, useState } from "react";
import { Calendar } from "./calendar";
import { Input } from "./input";

/** Local wall-clock editing; conversion to an instant belongs to the caller. */
export function DateTimePicker({
  value,
  onChange,
  disabled,
  invalid,
  timeZone,
}: {
  value: string;
  onChange(value: string): void;
  disabled?: boolean;
  invalid?: boolean;
  timeZone: string;
}) {
  const id = useId();
  const [date = "", time = ""] = value.split("T");
  const selected = date ? new Date(`${date}T12:00`) : undefined;
  const [month, setMonth] = useState(selected ?? new Date());
  return (
    <div className="w-72 max-w-full">
      <Calendar
        mode="single"
        required
        autoFocus
        selected={selected}
        month={month}
        onMonthChange={setMonth}
        disabled={disabled}
        onSelect={(day) => {
          const localDate = [
            day.getFullYear(),
            String(day.getMonth() + 1).padStart(2, "0"),
            String(day.getDate()).padStart(2, "0"),
          ].join("-");
          onChange(`${localDate}T${time}`);
        }}
      />
      <div className="mt-2 grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-2 border-t border-border pt-3">
        <div>
          <label htmlFor={`${id}-date`} className="mb-1 block text-xs text-muted-foreground">
            Date
          </label>
          <Input
            id={`${id}-date`}
            type="date"
            value={date}
            disabled={disabled}
            aria-invalid={invalid}
            onChange={(event) => {
              const next = event.target.value;
              onChange(`${next}T${time}`);
              if (next) setMonth(new Date(`${next}T12:00`));
            }}
          />
        </div>
        <div>
          <label htmlFor={`${id}-time`} className="mb-1 block text-xs text-muted-foreground">
            Time
          </label>
          <Input
            id={`${id}-time`}
            type="time"
            value={time}
            disabled={disabled}
            aria-invalid={invalid}
            onChange={(event) => onChange(`${date}T${event.target.value}`)}
          />
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{timeZone}</p>
    </div>
  );
}
