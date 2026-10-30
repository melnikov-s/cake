import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { ProjectTodo } from "../../contracts/projects/project-todos";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { localSnoozeDateTime, snoozeTimeZone } from "../lib/project-todo-snooze";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { DateTimePicker } from "@/components/ui/date-time-picker";

export const ProjectTodoSnoozePicker = observer(function ProjectTodoSnoozePicker({
  item,
  store,
  onClose,
}: {
  item: ProjectTodo;
  store: ProjectTodosStore;
  onClose(): void;
}) {
  const [value, setValue] = useState(() =>
    localSnoozeDateTime(item.snoozedUntil ?? new Date(Date.now() + 60 * 60_000).toISOString()),
  );
  const [error, setError] = useState<string>();
  return (
    <form
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        const date = new Date(value);
        if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
          setError("Choose a future date and time.");
          return;
        }
        setError(undefined);
        if (await store.snooze(item, date.toISOString())) onClose();
      }}
    >
      <DateTimePicker
        value={value}
        timeZone={snoozeTimeZone()}
        disabled={store.busy}
        invalid={Boolean(error)}
        onChange={(next) => {
          setValue(next);
          setError(undefined);
        }}
      />
      {(error || store.error) && (
        <Callout className="mt-3 max-w-72" variant="error" role="alert">
          {error || store.error}
        </Callout>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" disabled={store.busy} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={store.busy}>
          {item.snoozedUntil ? "Save" : "Snooze"}
        </Button>
      </div>
    </form>
  );
});
