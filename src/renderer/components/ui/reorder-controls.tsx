import { IconButton } from "./icon-button";
import { ChevronDownIcon } from "./icons";

/** Keyboard-accessible exact-position controls for an ordered group. */
export function ReorderControls({
  label,
  position,
  count,
  disabled = false,
  onMove,
}: {
  label: string;
  position: number;
  count: number;
  disabled?: boolean;
  onMove(position: number): void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <IconButton
        tooltip="Move up"
        ariaLabel={`Move up: ${label}`}
        disabled={disabled || position <= 1}
        onClick={() => onMove(position - 1)}
      >
        <span className="rotate-180" aria-hidden>
          <ChevronDownIcon />
        </span>
      </IconButton>
      <IconButton
        tooltip="Move down"
        ariaLabel={`Move down: ${label}`}
        disabled={disabled || position >= count}
        onClick={() => onMove(position + 1)}
      >
        <ChevronDownIcon />
      </IconButton>
    </div>
  );
}
