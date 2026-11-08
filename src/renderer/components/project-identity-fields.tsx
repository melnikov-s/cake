import { observer } from "r-state-tree/react";
import type { ProjectIdentityStore } from "../stores/ProjectIdentityStore";
import { Avatar } from "./ui/avatar";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { ProjectIconGenerator } from "./project-icon-generator";
import { FolderIcon } from "./ui/icons";

/** Shared identity draft; a registered project's folder is deliberately never editable. */
export const ProjectIdentityFields = observer(function ProjectIdentityFields({
  store,
  path,
  registered,
  disabled,
}: {
  store: ProjectIdentityStore;
  path: string;
  registered?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/80 bg-card/50">
      <div className="grid gap-3 px-3.5 py-3">
        <div className="flex items-center gap-3">
          <Avatar
            kind="project"
            seed={store.name || "Project"}
            customIcon={store.icon}
            className="size-12 shrink-0"
            aria-hidden="true"
          />
          <label className="grid min-w-0 flex-1 gap-1.5">
            <span className="text-xs font-medium">Project name</span>
            <Input
              aria-label="Project name"
              autoFocus
              maxLength={512}
              value={store.name}
              onChange={(event) => store.setName(event.target.value)}
              disabled={disabled}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void store.chooseIcon()}
            disabled={disabled || store.busy}
          >
            {store.choosingIcon ? "Choosing…" : "Choose icon…"}
          </Button>
          <ProjectIconGenerator store={store} disabled={disabled} />
          {store.icon && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => store.removeIcon()}
              disabled={disabled || store.busy}
            >
              Remove
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          <span>{store.icon ? "Custom icon" : "Generated from the project name"}</span> · PNG, JPEG,
          GIF, or WebP under 750 KB.
        </p>
        {store.error && (
          <p role="alert" className="text-xs text-destructive">
            {store.error}
          </p>
        )}
      </div>
      <div className="grid gap-1.5 px-3.5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="text-muted-foreground" aria-hidden="true">
            <FolderIcon />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">Project folder</p>
            <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{path}</p>
          </div>
          {registered && <span className="text-xs text-muted-foreground">Fixed</span>}
        </div>
        {registered && (
          <p className="text-xs text-muted-foreground">Registered folder can’t be changed here.</p>
        )}
      </div>
    </div>
  );
});
