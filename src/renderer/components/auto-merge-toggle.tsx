import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { IconButton } from "./ui/icon-button";
import { MergeResolveIcon } from "./ui/icons";

/** Explicit project ownership only; never infer scope from window selection. */
export const AutoMergeToggle = observer(function AutoMergeToggle({
  projectPath,
}: {
  projectPath: string | undefined;
}) {
  const root = useStore(RootStore);
  if (
    !projectPath ||
    !root.projectCatalogStore.projects.some((project) => project.path === projectPath)
  )
    return null;
  const project = root.autoMergeForProject(projectPath);
  const enabled = project?.enabled ?? false;
  return (
    <IconButton
      tooltip={`Auto-merge ${enabled ? "on" : "off"} — ${project?.status ?? "Enable for validated work directly delegated by this project’s Project Chat"}`}
      ariaLabel={`Auto-merge: ${enabled ? "on" : "off"}`}
      aria-pressed={enabled}
      pressedAppearance="subtle"
      wrapTooltip
      className="aria-pressed:text-worktree-merged aria-pressed:hover:text-worktree-merged aria-pressed:hover:bg-worktree-merged/10"
      onClick={() => void root.toggleAutoMerge(projectPath)}
    >
      <MergeResolveIcon />
    </IconButton>
  );
});
