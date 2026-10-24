import { Switch } from "../ui/switch";

export function SettingsToggle({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id?: string;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  instant?: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <div
      id={id}
      className="scroll-mt-8 flex items-center justify-between gap-4 px-3.5 py-2.5 text-sm"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <strong className="text-xs font-medium text-foreground">{label}</strong>
        <small className="text-xs text-muted-foreground">{description}</small>
      </span>
      <Switch checked={checked} disabled={disabled} aria-label={label} onCheckedChange={onChange} />
    </div>
  );
}
