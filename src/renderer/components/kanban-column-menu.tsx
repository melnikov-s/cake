import { useId, useState } from "react";
import type { ProjectWorkflowColor } from "../../domain/application/application-data";
import { Button } from "./ui/button";
import { ColorPicker } from "./ui/color-picker";
import { EditIcon, TrashIcon } from "./ui/icons";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverIconTrigger } from "./ui/popover";

export interface KanbanColumnMenuProps {
  name: string;
  color: ProjectWorkflowColor;
  busy: boolean;
  onUpdate(input: { name?: string; color?: ProjectWorkflowColor }): Promise<boolean>;
  onDelete(): Promise<boolean>;
}

export function KanbanColumnMenu({ name, color, busy, onUpdate, onDelete }: KanbanColumnMenuProps) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const [draftColor, setDraftColor] = useState(color);
  const save = async () => {
    if (await onUpdate({ name: draftName, color: draftColor })) setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setDraftName(name);
          setDraftColor(color);
        }
      }}
    >
      <PopoverIconTrigger tooltip={`Edit ${name}`} ariaLabel={`Edit ${name} status`}>
        <EditIcon />
      </PopoverIconTrigger>
      <PopoverContent align="end" className="w-64 space-y-3">
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-muted-foreground" htmlFor={inputId}>
            Status name
          </label>
          <Input
            id={inputId}
            value={draftName}
            maxLength={40}
            disabled={busy}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
          />
        </div>
        <ColorPicker value={draftColor} onChange={setDraftColor} disabled={busy} />
        <div className="flex items-center justify-between border-t border-border pt-3">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => void onDelete().then((deleted) => deleted && setOpen(false))}
          >
            <TrashIcon /> Delete
          </Button>
          <Button size="sm" disabled={busy || !draftName.trim()} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
