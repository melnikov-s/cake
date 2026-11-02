import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import type { AutomationSchedule } from "../../../contracts/automations/automation-data";
import {
  calendarControls,
  calendarExpression,
  intervalUnit,
  localDateTime,
} from "../../lib/automation-schedule";
import { Select } from "../ui/select";
import { Input } from "../ui/input";

export const AutomationScheduleFields = observer(function AutomationScheduleFields() {
  const editor = useStore(RootStore).automationsStore.editor;
  const definition = editor.definition;
  if (definition?.trigger._tag !== "Schedule") return null;
  const schedule = definition.trigger.schedule;
  const setSchedule = (value: AutomationSchedule) =>
    editor.patch({ trigger: { _tag: "Schedule", schedule: value } });
  const startsAt = schedule._tag === "Once" ? schedule.at : schedule.startsAt;
  const calendar = schedule._tag === "Calendar" ? calendarControls(schedule) : undefined;
  const changeCalendar = (patch: Partial<NonNullable<typeof calendar>>) => {
    if (schedule._tag === "Calendar" && calendar)
      setSchedule({ ...schedule, expression: calendarExpression({ ...calendar, ...patch }) });
  };
  const unit = schedule._tag === "Interval" ? intervalUnit(schedule.everySeconds) : 60;
  return (
    <div className="grid gap-3">
      <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
        <span className="text-muted-foreground">Repeat</span>
        <Select
          aria-label="Schedule repeat"
          value={schedule._tag}
          onChange={(event) => {
            const tag = event.currentTarget.value;
            setSchedule(
              tag === "Once"
                ? { _tag: "Once", at: startsAt }
                : tag === "Interval"
                  ? { _tag: "Interval", startsAt, everySeconds: 86400 }
                  : {
                      _tag: "Calendar",
                      startsAt,
                      expression: "0 9 * * *",
                      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    },
            );
          }}
        >
          <option value="Once">Once</option>
          <option value="Interval">Fixed interval</option>
          <option value="Calendar">Calendar</option>
        </Select>
      </label>
      <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
        <span className="text-muted-foreground">
          {schedule._tag === "Once" ? "At (local)" : "From (local)"}
        </span>
        <Input
          type="datetime-local"
          aria-label="Schedule start"
          value={localDateTime(startsAt)}
          onChange={(event) => {
            const date = new Date(event.currentTarget.value);
            if (!Number.isNaN(date.getTime()))
              setSchedule(
                schedule._tag === "Once"
                  ? { ...schedule, at: date.toISOString() }
                  : { ...schedule, startsAt: date.toISOString() },
              );
          }}
        />
      </label>
      {schedule._tag === "Interval" && (
        <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
          <span className="text-muted-foreground">Every</span>
          <div className="flex gap-2">
            <Input
              type="number"
              aria-label="Repeat amount"
              min={1}
              value={schedule.everySeconds / unit}
              onChange={(event) =>
                setSchedule({ ...schedule, everySeconds: Number(event.currentTarget.value) * unit })
              }
            />
            <Select
              aria-label="Repeat unit"
              value={unit}
              onChange={(event) =>
                setSchedule({
                  ...schedule,
                  everySeconds: (schedule.everySeconds / unit) * Number(event.currentTarget.value),
                })
              }
            >
              <option value={1}>seconds</option>
              <option value={60}>minutes</option>
              <option value={3600}>hours</option>
              <option value={86400}>days</option>
            </Select>
          </div>
        </div>
      )}
      {schedule._tag === "Calendar" && calendar && (
        <>
          <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
            <span className="text-muted-foreground">Calendar</span>
            <Select
              aria-label="Calendar recurrence"
              value={calendar.repeat}
              onChange={(event) => {
                const repeat = event.currentTarget.value;
                if (
                  repeat === "daily" ||
                  repeat === "weekdays" ||
                  repeat === "weekly" ||
                  repeat === "monthly"
                )
                  changeCalendar({ repeat });
              }}
            >
              {calendar.repeat === "custom" && (
                <option value="custom">Custom calendar recurrence</option>
              )}
              <option value="daily">Daily</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </Select>
          </label>
          {calendar.repeat !== "custom" && (
            <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
              <span className="text-muted-foreground">Time</span>
              <Input
                type="time"
                aria-label="Calendar time"
                value={calendar.time}
                onChange={(event) => changeCalendar({ time: event.currentTarget.value })}
              />
            </label>
          )}
          {calendar.repeat === "weekly" && (
            <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
              <span className="text-muted-foreground">On</span>
              <Select
                aria-label="Calendar weekday"
                value={calendar.weekday}
                onChange={(event) => changeCalendar({ weekday: Number(event.currentTarget.value) })}
              >
                {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map(
                  (day, index) => (
                    <option key={day} value={index}>
                      {day}
                    </option>
                  ),
                )}
              </Select>
            </label>
          )}
          {calendar.repeat === "monthly" && (
            <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
              <span className="text-muted-foreground">Day</span>
              <Input
                type="number"
                min={1}
                max={31}
                aria-label="Calendar month day"
                value={calendar.day}
                onChange={(event) => changeCalendar({ day: Number(event.currentTarget.value) })}
              />
            </label>
          )}
          <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
            <span className="text-muted-foreground">Time zone</span>
            <Input
              aria-label="Calendar time zone"
              value={schedule.timeZone}
              onChange={(event) =>
                setSchedule({ ...schedule, timeZone: event.currentTarget.value })
              }
            />
          </label>
        </>
      )}
    </div>
  );
});
