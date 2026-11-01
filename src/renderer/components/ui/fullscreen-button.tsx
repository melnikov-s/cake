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
      className={cn("fullscreen-trigger", className)}
      tooltip="View fullscreen"
      ariaLabel={label}
      disabled={disabled}
      onClick={onClick}
    >
      <ExpandIcon />
    </IconButton>
  );
}
