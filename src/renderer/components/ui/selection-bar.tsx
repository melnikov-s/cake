import { IconButton } from "./icon-button";
import { CloseIcon } from "./icons";

/** Compact selection context, outside the content's scroll region. */
export function SelectionBar({
  title,
  onClear,
  clearLabel,
  disabled,
}: {
  title: string;
  onClear(): void;
  clearLabel: string;
  disabled?: boolean;
}) {
  return (
    <div
      data-slot="selection-bar"
      className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border/65 px-3 py-0.5 text-xs"
    >
      <span className="shrink-0">Currently selected:</span>
      <span className="min-w-0 flex-1 truncate" title={title}>
        {title}
      </span>
      <IconButton tooltip={clearLabel} disabled={disabled} onClick={onClear}>
        <CloseIcon />
      </IconButton>
    </div>
  );
}
