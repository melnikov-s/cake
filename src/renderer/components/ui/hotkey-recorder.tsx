import { useState, type KeyboardEvent } from "react";
import { hotkeyFromKeyboardEvent, formatHotkey } from "@/lib/hotkeys";
import { Button } from "./button";
import { cn } from "@/lib/utils";

export interface HotkeyRecorderProps {
  value: string;
  defaultValue: string;
  label: string;
  onChange(value: string): void;
  onClear(): void;
  onReset(): void;
}

/** A keyboard-accessible control for recording one application shortcut. */
export function HotkeyRecorder({
  value,
  defaultValue,
  label,
  onChange,
  onClear,
  onReset,
}: HotkeyRecorderProps) {
  const [recording, setRecording] = useState(false);
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(false);
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      onClear();
      setRecording(false);
      return;
    }
    const binding = hotkeyFromKeyboardEvent(event.nativeEvent);
    if (!binding) return;
    onChange(binding);
    setRecording(false);
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        data-slot="hotkey-recorder"
        aria-label={`${label} shortcut${recording ? ", recording" : ""}`}
        aria-pressed={recording}
        className={cn(
          "min-w-28 justify-center font-mono font-medium",
          recording && "border-ring bg-muted ring-2 ring-ring/25",
          !value && "text-muted-foreground",
        )}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={keyDown}
      >
        {recording ? "Press shortcut…" : formatHotkey(value)}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="px-2 text-[11px]"
        disabled={value === defaultValue}
        onClick={onReset}
      >
        Reset
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="px-2 text-[11px]"
        disabled={!value}
        onClick={onClear}
      >
        Clear
      </Button>
    </div>
  );
}
