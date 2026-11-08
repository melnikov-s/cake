import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { cn } from "../lib/utils";
import { IconButton } from "./ui/icon-button";
import { MergeResolveIcon } from "./ui/icons";

/** All surfaces share the backend-owned, user-authorized opt-in. */
export const AutoMergeToggle = observer(function AutoMergeToggle({
  rail = false,
  showLabel = false,
}: {
  rail?: boolean;
  showLabel?: boolean;
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
      className={cn(rail && "h-9 shrink-0", showLabel && "flex w-auto gap-1.5 px-2 text-xs")}
      onClick={() => void root.toggleAutoMerge()}
    >
      <MergeResolveIcon />
      {showLabel && <span>Auto-merge {root.autoMergeEnabled ? "on" : "off"}</span>}
    </IconButton>
  );
});
