import { Chip } from "@/components/ui/chip";
import { LightningIcon } from "@/components/ui/icons";

export function FastModeToggle({
  enabled,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  disabled?: boolean;
  onToggle(enabled: boolean): void;
}) {
  return (
    <Chip
      active={enabled}
      role="switch"
      aria-label="Fast mode"
      aria-checked={enabled}
      disabled={disabled}
      title={enabled ? "Fast mode on" : "Fast mode off"}
      onClick={() => onToggle(!enabled)}
      icon={<LightningIcon />}
      className="h-7.5 rounded-[7px] px-2 text-xs font-semibold"
    >
      <span>Fast</span>
    </Chip>
  );
}
