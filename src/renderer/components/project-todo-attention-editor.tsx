import { useEffect, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import type { ProjectTodo } from "../../contracts/projects/project-todos";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/ui/callout";

export const ProjectTodoAttentionEditor = observer(function ProjectTodoAttentionEditor({
  item,
  store,
  onClose,
}: {
  item: ProjectTodo;
  store: ProjectTodosStore;
  onClose(): void;
}) {
  const [value, setValue] = useState(item.attentionReason ?? "");
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <form
      className="w-72"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        if (!value.trim()) {
          setError("Enter what needs your attention.");
          return;
        }
        setError(undefined);
        if (await store.setAttention(item, true, value)) onClose();
      }}
    >
      <label className="mb-2 block text-xs font-medium" htmlFor={`attention-${item.id}`}>
        What needs your attention?
      </label>
      <Input
        ref={input}
        id={`attention-${item.id}`}
        value={value}
        maxLength={512}
        disabled={store.busy}
        aria-invalid={Boolean(error)}
        placeholder="Review the findings or choose the next step…"
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
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" disabled={store.busy} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={store.busy}>
          {item.needsAttention ? "Save" : "Add"}
        </Button>
      </div>
    </form>
  );
});
