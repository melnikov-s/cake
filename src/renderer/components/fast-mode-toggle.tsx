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
      className="fast-mode-toggle"
      type="button"
      role="switch"
      aria-label="Fast mode"
      aria-checked={enabled}
      disabled={disabled}
      title={enabled ? "Fast mode on" : "Fast mode off"}
      onClick={() => onToggle(!enabled)}
    >
      <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
        <path d="M13.4 2 4 13.1h6.6L9.7 22 20 9.7h-6.8L13.4 2Z" />
      </svg>
      <span>Fast</span>
    </button>
  );
}
