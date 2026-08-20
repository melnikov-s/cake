export function SettingsToggle({
  label,
  description,
  checked,
  disabled,
  instant = false,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  instant?: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <div className="settings-field">
      <span>
        {label}
        <small>{description}</small>
      </span>
      <button
        className={`settings-switch${instant ? " settings-switch-instant" : ""}`}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <i />
      </button>
    </div>
  );
}
