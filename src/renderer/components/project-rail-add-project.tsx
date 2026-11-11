import { IconButton } from "./ui/icon-button";
import { FolderPlusIcon, PlusIcon } from "./ui/icons";
import { NavigationRailSection } from "./ui/navigation-rail-section";

/**
 * Where the rail offers Add project:
 * - "heading": the Projects section label acts as Add project (default).
 * - "row": a quiet action row after the last project.
 * Change the default here to switch the whole app.
 */
export type AddProjectPlacement = "heading" | "row";
export const defaultAddProjectPlacement: AddProjectPlacement = "heading";

/** One Add project target across the full heading, with the same glyph at either width. */
export function AddProjectHeadingButton({ onAdd }: { onAdd(): void }) {
  return (
    <NavigationRailSection
      label="Projects"
      action={{ label: "Add project", icon: <FolderPlusIcon />, onClick: onAdd }}
    />
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
