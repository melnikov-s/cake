import { useContext } from "react";
import { IconButton } from "./ui/icon-button";
import { FolderPlusIcon, PlusIcon } from "./ui/icons";
import { NavigationRailLabelsContext } from "./ui/navigation-rail-labels";

/**
 * Where the rail offers Add project:
 * - "heading": a small + on the Projects section label (default).
 * - "row": a quiet action row after the last project.
 * Change the default here to switch the whole app.
 */
export type AddProjectPlacement = "heading" | "row";
export const defaultAddProjectPlacement: AddProjectPlacement = "heading";

/** Compact + beside the Projects label; the icon-only rail shows the folder glyph instead. */
export function AddProjectHeadingButton({ onAdd }: { onAdd(): void }) {
  const labelsVisible = useContext(NavigationRailLabelsContext) !== false;
  return (
    <IconButton
      tooltip="Add project"
      iconSize={labelsVisible ? "inline" : "navigation"}
      className={labelsVisible ? "size-6" : "size-7"}
      onClick={onAdd}
    >
      {labelsVisible ? <PlusIcon /> : <FolderPlusIcon />}
    </IconButton>
  );
}

/** Quiet action row at the end of the project list. */
export function AddProjectRow({ className, onAdd }: { className?: string; onAdd(): void }) {
  return (
    <IconButton tooltip="Add project" label="Add project" className={className} onClick={onAdd}>
      <PlusIcon />
    </IconButton>
  );
}
