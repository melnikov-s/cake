import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { cn } from "../lib/utils";
import { IconButton } from "./ui/icon-button";
import { MergeResolveIcon } from "./ui/icons";

/** All surfaces share the backend-owned, user-authorized opt-in. */
export const AutoMergeToggle = observer(function AutoMergeToggle({
  rail = false,
}: {
  rail?: boolean;
}) {
  const root = useStore(RootStore);
  return (
    <IconButton
      tooltip={`Auto-merge ${root.autoMergeEnabled ? "on" : "off"} — ${root.autoMergeStatus ?? "Enable to merge current valid ready work and future validated completions"}`}
      ariaLabel={`Auto-merge: ${root.autoMergeEnabled ? "on" : "off"}`}
      label={rail ? `Auto-merge ${root.autoMergeEnabled ? "on" : "off"}` : undefined}
      aria-pressed={root.autoMergeEnabled}
      pressedAppearance="subtle"
      wrapTooltip
      className={cn(
        "aria-pressed:text-worktree-merged aria-pressed:hover:text-worktree-merged aria-pressed:hover:bg-worktree-merged/10",
        rail && "h-9 shrink-0",
      )}
      onClick={() => void root.toggleAutoMerge()}
    >
      <MergeResolveIcon />
    </IconButton>
  );
});
