import { useEffect, useId, useState } from "react";
import { observer } from "r-state-tree/react";
import type { ProjectTodo } from "../../contracts/projects/project-todos";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { localSnoozeDateTime, snoozeTimeZone } from "../lib/project-todo-snooze";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import {
  DialogBackdrop,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const ProjectTodoSnoozeDialog = observer(function ProjectTodoSnoozeDialog({
  item,
  store,
}: {
  item: ProjectTodo;
  store: ProjectTodosStore;
}) {
  const inputId = useId();
  const titleId = useId();
  const [value, setValue] = useState(() =>
    localSnoozeDateTime(item.snoozedUntil ?? new Date(Date.now() + 60 * 60_000).toISOString()),
  );
  const [error, setError] = useState<string>();
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !store.busy) store.closeSnooze();
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [store]);
  return (
    <DialogBackdrop aria-labelledby={titleId} onClose={() => !store.busy && store.closeSnooze()}>
      <DialogContent className="max-w-sm">
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const date = new Date(value);
            if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
              setError("Choose a future date and time.");
              return;
            }
            setError(undefined);
            void store.snooze(item, date.toISOString());
          }}
        >
          <DialogHeader>
            <DialogTitle id={titleId}>
              {item.snoozedUntil ? "Change snooze" : "Snooze to-do"}
            </DialogTitle>
          </DialogHeader>
          <p className="mt-3 text-sm font-medium">{item.title}</p>
          <label htmlFor={inputId} className="mb-1 mt-4 block text-xs text-muted-foreground">
            Until ({snoozeTimeZone()})
          </label>
          <Input
            id={inputId}
            type="datetime-local"
            value={value}
            autoFocus
            disabled={store.busy}
            aria-invalid={Boolean(error)}
            onChange={(event) => {
              setValue(event.target.value);
              setError(undefined);
            }}
          />
          {(error || store.error) && (
            <Callout className="mt-3" variant="error" role="alert">
              {error || store.error}
            </Callout>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={store.busy} onClick={() => store.closeSnooze()}>
              Cancel
            </Button>
            <Button type="submit" disabled={store.busy}>
              {item.snoozedUntil ? "Save" : "Snooze"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </DialogBackdrop>
  );
});
