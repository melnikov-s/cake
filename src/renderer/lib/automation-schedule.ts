import type { AutomationSchedule } from "../../contracts/automations/automation-data";

export function localDateTime(instant: string) {
  const date = new Date(instant);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

type CalendarRepeat = "daily" | "weekdays" | "weekly" | "monthly";
export interface CalendarControls {
  repeat: CalendarRepeat | "custom";
  time: string;
  weekday: number;
  day: number;
}
export function calendarControls(
  schedule: Extract<AutomationSchedule, { _tag: "Calendar" }>,
): CalendarControls {
  const match = /^(\d{1,2}) (\d{1,2}) (\*|\d{1,2}) \* (\*|1-5|[0-6])$/.exec(schedule.expression);
  if (!match || (match[3] !== "*" && match[4] !== "*"))
    return { repeat: "custom", time: "09:00", weekday: 1, day: 1 };
  return {
    repeat:
      match[3] !== "*"
        ? "monthly"
        : match[4] === "1-5"
          ? "weekdays"
          : match[4] === "*"
            ? "daily"
            : "weekly",
    time: `${match[2]!.padStart(2, "0")}:${match[1]!.padStart(2, "0")}`,
    weekday: match[4] && /^[0-6]$/.test(match[4]) ? Number(match[4]) : 1,
    day: match[3] === "*" ? 1 : Number(match[3]),
  };
}
export function calendarExpression(controls: CalendarControls) {
  const [hour = "9", minute = "0"] = controls.time.split(":");
  return `${Number(minute)} ${Number(hour)} ${controls.repeat === "monthly" ? controls.day : "*"} * ${controls.repeat === "weekdays" ? "1-5" : controls.repeat === "weekly" ? controls.weekday : "*"}`;
}
export function intervalUnit(seconds: number) {
  return seconds % 86400 === 0 ? 86400 : seconds % 3600 === 0 ? 3600 : seconds % 60 === 0 ? 60 : 1;
}
