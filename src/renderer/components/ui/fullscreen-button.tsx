import { IconButton } from "@/components/ui/icon-button";
import { ExpandIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

export function FullscreenButton({
  className,
  disabled,
  label,
  onClick,
}: {
  className?: string;
  disabled?: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <IconButton
      className={cn("fullscreen-trigger -translate-x-0.5 -translate-y-0.5", className)}
      tooltip="View fullscreen"
      ariaLabel={label}
      disabled={disabled}
      onClick={onClick}
    >
      <ExpandIcon />
    </IconButton>
  );
}
