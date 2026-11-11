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
  const project = root.autoMergeForProject(projectPath);
  const enabled = project?.enabled ?? false;
  const description =
    project?.status ??
    "Enable for validated work directly delegated by this project’s Project Chat";
  return (
    <label
      className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap px-1 text-xs font-medium text-muted-foreground"
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
      Auto-merge
      <Switch
        checked={enabled}
        aria-label={`Auto-merge: ${enabled ? "on" : "off"}`}
        aria-description={description}
        onCheckedChange={() => void root.toggleAutoMerge(projectPath)}
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
