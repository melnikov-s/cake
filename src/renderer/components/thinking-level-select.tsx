import { thinkingLevelSchema, type ThinkingLevel } from "../../ipc/session-contract";

export function ThinkingLevelSelect({ ariaLabel, value, levels, disabled, onSelect }: {
  ariaLabel: string;
  value: ThinkingLevel;
  levels: readonly ThinkingLevel[];
  disabled?: boolean;
  onSelect(level: ThinkingLevel): void;
}) {
  return <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(event) => onSelect(thinkingLevelSchema.parse(event.target.value))}>
    {levels.map((level) => <option key={level} value={level}>{thinkingLevelLabel(level)}</option>)}
  </select>;
}

function thinkingLevelLabel(level: ThinkingLevel) {
  return level === "off" ? "No reasoning" : `${level.charAt(0).toUpperCase()}${level.slice(1)} reasoning`;
}
