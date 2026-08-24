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
    <button
      className="inline-flex h-[30px] items-center gap-1 rounded-[7px] border border-transparent bg-[color-mix(in_oklab,var(--muted)_62%,transparent)] px-[7px] py-0 text-[11px] font-semibold text-muted-foreground cursor-pointer transition-none hover:not-disabled:bg-[color-mix(in_oklab,var(--muted)_84%,var(--foreground)_16%)] hover:not-disabled:text-foreground disabled:cursor-default disabled:opacity-[0.72] aria-checked:border-[color-mix(in_oklab,var(--accent)_58%,var(--border))] aria-checked:bg-[color-mix(in_oklab,var(--accent)_18%,var(--muted))] aria-checked:text-foreground aria-checked:font-bold aria-checked:[&_svg]:text-accent aria-checked:[box-shadow:inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_14%,transparent)] aria-checked:hover:not-disabled:bg-[color-mix(in_oklab,var(--accent)_25%,var(--muted))] aria-checked:disabled:opacity-100"
      type="button"
      role="switch"
      aria-label="Fast mode"
      aria-checked={enabled}
      disabled={disabled}
      title={enabled ? "Fast mode on" : "Fast mode off"}
      onClick={() => onToggle(!enabled)}
    >
      <LightningIcon />
      <span>Fast</span>
    </button>
  );
}
