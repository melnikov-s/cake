import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { ProjectWorkflowColor } from "../../domain/application/application-data";
import type { ProjectSettingsStore } from "../stores/ProjectSettingsStore";
import { Button } from "./ui/button";
import { ColorPicker } from "./ui/color-picker";
import { IconButton } from "./ui/icon-button";
import { PlusIcon, TrashIcon } from "./ui/icons";
import { Input } from "./ui/input";

export const ProjectStatusSettings = observer(function ProjectStatusSettings({
  store,
}: {
  store: ProjectSettingsStore;
}) {
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<ProjectWorkflowColor>("sky");
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});

  const add = async () => {
    if (!(await store.addStatus(newName, newColor))) return;
    setNewName("");
    setNewColor("sky");
  };

  return (
    <section
      className="grid gap-3 border-t border-border pt-5"
      aria-labelledby="status-labels-title"
    >
      <div>
        <h3 id="status-labels-title" className="text-xs font-semibold text-foreground">
          Session statuses
        </h3>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Pick a label from the avatar beside a new or draft chat. Changes save immediately.
        </p>
      </div>

      <div className="grid gap-2">
        {store.statuses.map((status) => {
          const draft = nameDrafts[status.id] ?? status.name;
          const pending = store.statusPending(status.id);
          const commitName = () => {
            setNameDrafts((current) => {
              const next = { ...current };
              delete next[status.id];
              return next;
            });
            if (draft.trim() && draft.trim() !== status.name)
              void store.updateStatus(status.id, { name: draft });
          };
          return (
            <div
              key={status.id}
              className="grid gap-2 rounded-lg border border-border bg-muted/30 p-2.5"
            >
              <div className="flex items-center gap-2">
                <Input
                  size="sm"
                  value={draft}
                  maxLength={40}
                  disabled={pending}
                  aria-label={`${status.name} status name`}
                  onChange={(event) =>
                    setNameDrafts((current) => ({
                      ...current,
                      [status.id]: event.target.value,
                    }))
                  }
                  onBlur={commitName}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setNameDrafts((current) => {
                        const next = { ...current };
                        delete next[status.id];
                        return next;
                      });
                    }
                  }}
                />
                <IconButton
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  tooltip={`Delete ${status.name}`}
                  disabled={pending}
                  onClick={() => void store.deleteStatus(status.id)}
                >
                  <TrashIcon />
                </IconButton>
              </div>
              <ColorPicker
                value={status.color}
                disabled={pending}
                label={`Color for ${status.name}`}
                onChange={(color) => void store.updateStatus(status.id, { color })}
              />
            </div>
          );
        })}
      </div>

      <div className="grid gap-2 rounded-lg border border-dashed border-border p-2.5">
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            value={newName}
            maxLength={40}
            placeholder="New status"
            aria-label="New status name"
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void add();
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            className="shrink-0 gap-1.5"
            disabled={!newName.trim() || store.addingStatus}
            onClick={() => void add()}
          >
            <PlusIcon /> Add
          </Button>
        </div>
        <ColorPicker value={newColor} onChange={setNewColor} label="New status color" />
      </div>
    </section>
  );
});
