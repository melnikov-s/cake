import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { SessionLabel, SessionLabelColor } from "../../domain/application/application-data";
import { Button } from "./ui/button";
import { ColorPicker } from "./ui/color-picker";
import { IconButton } from "./ui/icon-button";
import { ChevronDownIcon, EditIcon, PlusIcon, TrashIcon } from "./ui/icons";
import { Input } from "./ui/input";
import { LabelSwatch } from "./ui/label-swatch";

export interface LabelSettingsStore {
  readonly labels: ReadonlyArray<SessionLabel>;
  readonly addingLabel: boolean;
  labelPending(labelId: string): boolean;
  addLabel(name: string, color: SessionLabelColor): Promise<boolean>;
  updateLabel(
    labelId: string,
    input: { name?: string; color?: SessionLabelColor },
  ): Promise<boolean>;
  moveLabel(labelId: string, index: number): Promise<boolean>;
  deleteLabel(labelId: string): Promise<boolean>;
}

export const LabelSettings = observer(function LabelSettings({
  store,
  title,
  description,
  placeholder = "New label",
}: {
  store: LabelSettingsStore;
  title: string;
  description: string;
  placeholder?: string;
}) {
  const [editingId, setEditingId] = useState<string>();
  const [newLabelOpen, setNewLabelOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<SessionLabelColor>("sky");
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});

  const add = async () => {
    if (!(await store.addLabel(newName, newColor))) return;
    setNewName("");
    setNewColor("sky");
    setNewLabelOpen(false);
  };

  return (
    <section
      className="grid gap-3 border-t border-border pt-5"
      aria-labelledby="session-labels-title"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 id="session-labels-title" className="text-xs font-semibold text-foreground">
            {title}
          </h3>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0 gap-1.5"
          onClick={() => setNewLabelOpen((open) => !open)}
        >
          <PlusIcon /> Add label
        </Button>
      </div>

      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {store.labels.map((label, index) => {
          const editing = editingId === label.id;
          const draft = nameDrafts[label.id] ?? label.name;
          const pending = store.labelPending(label.id);
          return (
            <div key={label.id} className="bg-card">
              <div className="flex h-11 items-center gap-2.5 px-3">
                <LabelSwatch color={label.color} className="size-3" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">{label.name}</span>
                <IconButton
                  className="text-muted-foreground"
                  tooltip={`Move ${label.name} up`}
                  disabled={pending || index === 0}
                  onClick={() => void store.moveLabel(label.id, index - 1)}
                >
                  <span className="rotate-180">
                    <ChevronDownIcon />
                  </span>
                </IconButton>
                <IconButton
                  className="text-muted-foreground"
                  tooltip={`Move ${label.name} down`}
                  disabled={pending || index === store.labels.length - 1}
                  onClick={() => void store.moveLabel(label.id, index + 1)}
                >
                  <ChevronDownIcon />
                </IconButton>
                <IconButton
                  className="text-muted-foreground"
                  tooltip={`Edit ${label.name}`}
                  disabled={pending}
                  onClick={() => setEditingId(editing ? undefined : label.id)}
                >
                  <EditIcon />
                </IconButton>
              </div>
              {editing && (
                <div className="grid gap-3 border-t border-border bg-muted/25 p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      size="sm"
                      value={draft}
                      maxLength={40}
                      disabled={pending}
                      aria-label={`${label.name} label name`}
                      onChange={(event) =>
                        setNameDrafts((current) => ({
                          ...current,
                          [label.id]: event.target.value,
                        }))
                      }
                    />
                    <Button
                      type="button"
                      size="sm"
                      disabled={!draft.trim() || pending}
                      onClick={() => {
                        if (draft.trim() !== label.name)
                          void store.updateLabel(label.id, { name: draft });
                        setEditingId(undefined);
                      }}
                    >
                      Done
                    </Button>
                    <IconButton
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      tooltip={`Delete ${label.name}`}
                      disabled={pending}
                      onClick={() => void store.deleteLabel(label.id)}
                    >
                      <TrashIcon />
                    </IconButton>
                  </div>
                  <ColorPicker
                    value={label.color}
                    disabled={pending}
                    label={`Color for ${label.name}`}
                    onChange={(color) => void store.updateLabel(label.id, { color })}
                  />
                </div>
              )}
            </div>
          );
        })}
        {store.labels.length === 0 && (
          <p className="px-3 py-5 text-center text-xs text-muted-foreground">No labels yet.</p>
        )}
      </div>

      {newLabelOpen && (
        <div className="grid gap-3 rounded-lg border border-border bg-muted/25 p-3">
          <div className="flex items-center gap-2">
            <Input
              size="sm"
              value={newName}
              maxLength={40}
              placeholder={placeholder}
              aria-label="New label name"
              autoFocus
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
              disabled={!newName.trim() || store.addingLabel}
              onClick={() => void add()}
            >
              Create
            </Button>
          </div>
          <ColorPicker value={newColor} onChange={setNewColor} label="New label color" />
        </div>
      )}
    </section>
  );
});
