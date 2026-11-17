import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { cn } from "@/lib/utils";
import { Switch } from "./ui/switch";
import { IconSizeProvider } from "./ui/icon-size";
import { TooltipBubble, useTooltip } from "./ui/tooltip";
import { MergeResolveIcon } from "./ui/icons";

/** Explicit project ownership only; never infer scope from window selection. */
export const AutoMergeToggle = observer(function AutoMergeToggle({
  projectPath,
}: {
  projectPath: string | undefined;
}) {
  const root = useStore(RootStore);
  const { anchor, show, hide } = useTooltip();
  if (
    !projectPath ||
    !root.projectCatalogStore.projects.some((project) => project.path === projectPath) ||
    root.projectCatalogStore.find(projectPath)?.settings.worktreeLanding === "pull-request"
  )
    return null;
  const store = root.autoMergeStore;
  const project = store.forProject(projectPath);
  const pendingTarget = store.pendingTarget(projectPath);
  const pending = pendingTarget !== undefined;
  const pendingLabel = pendingTarget ? "Enabling…" : "Disabling…";
  const enabled = project?.enabled ?? false;
  const scope =
    "Validated work directly delegated by this project’s Project Chat only. Never My sessions.";
  const status = pending ? pendingLabel : project?.status;
  const description = status ? `${status} — ${scope}` : scope;
  return (
    <label
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap px-1 text-xs font-medium text-muted-foreground",
        pending ? "cursor-wait" : "cursor-pointer",
      )}
      onMouseEnter={(event) => show(event.currentTarget)}
      onMouseLeave={hide}
      onMouseDown={hide}
      onFocus={(event) => {
        if (event.target.matches(":focus-visible")) show(event.currentTarget);
      }}
      onBlur={hide}
    >
      <span aria-hidden="true" className={cn("flex", enabled && "text-worktree-merged")}>
        <IconSizeProvider size="inline">
          <MergeResolveIcon />
        </IconSizeProvider>
      </span>
      <span role={pending ? "status" : undefined} aria-live="polite">
        {pending ? pendingLabel : "Auto-merge"}
      </span>
      <Switch
        checked={enabled}
        aria-label={`Auto-merge: ${enabled ? "on" : "off"}`}
        aria-description={description}
        aria-busy={pending}
        disabled={pending}
        onCheckedChange={() => void store.toggle(projectPath)}
      />
      {anchor && (
        <TooltipBubble
          label={`Auto-merge ${enabled ? "on" : "off"} — ${description}`}
          anchor={anchor}
          wrap
        />
      )}
    </label>
  );
});
