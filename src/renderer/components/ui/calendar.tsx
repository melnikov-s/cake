import { useEffect, useRef, type ComponentProps } from "react";
import { DayPicker, type DayButton } from "react-day-picker";
import { Button } from "./button";
import { ChevronIcon } from "./icons";
import { cn } from "@/lib/utils";

/** Shadcn's React DayPicker approach, using Cake controls and semantic theme tokens. */
export function Calendar({
  className,
  classNames,
  components,
  ...props
}: ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays
      className={cn("w-full p-2", className)}
      classNames={{
        months: "relative flex flex-col",
        month: "flex w-full flex-col gap-2",
        month_caption: "flex h-8 items-center justify-center px-9",
        caption_label: "text-xs font-semibold",
        nav: "absolute inset-x-0 top-0 flex items-center justify-between",
        button_previous: "size-8 p-0",
        button_next: "size-8 p-0",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "flex-1 py-1 text-center text-xs font-normal text-muted-foreground",
        week: "mt-1 flex w-full",
        day: "group/day relative flex-1 p-0 text-center text-xs",
        day_button: "h-8 w-full p-0 font-normal text-foreground",
        selected:
          "[&_button]:bg-primary [&_button]:text-primary-foreground [&_button]:hover:bg-primary/90",
        today: "[&_button]:ring-1 [&_button]:ring-ring/50",
        outside: "opacity-45",
        disabled: "opacity-35",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Button: CalendarNavigationButton,
        DayButton: CalendarDayButton,
        Chevron: ({ orientation }) => (
          <ChevronIcon className={orientation === "left" ? "rotate-90" : "-rotate-90"} />
        ),
        ...components,
      }}
      {...props}
    />
  );
}

function CalendarNavigationButton(props: ComponentProps<typeof Button>) {
  return <Button variant="ghost" {...props} />;
}

function CalendarDayButton({ day, modifiers, ...props }: ComponentProps<typeof DayButton>) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (modifiers.focused) ref.current?.focus();
  }, [modifiers.focused]);
  return <Button ref={ref} variant="ghost" data-day={day.date.toLocaleDateString()} {...props} />;
}
