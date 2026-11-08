import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
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
      tooltip={`Auto-merge ${root.autoMergeEnabled ? "on" : "off"} — ${root.autoMergeStatus ?? "Only fresh, validated completions merge and resolve"}`}
      ariaLabel={`Auto-merge: ${root.autoMergeEnabled ? "on" : "off"}`}
      label={rail ? `Auto-merge ${root.autoMergeEnabled ? "on" : "off"}` : undefined}
      aria-pressed={root.autoMergeEnabled}
      pressedAppearance="subtle"
      wrapTooltip
      className={rail ? "h-9 shrink-0" : undefined}
      onClick={() => void root.toggleAutoMerge()}
    >
      <MergeResolveIcon />
    </IconButton>
  );
});
