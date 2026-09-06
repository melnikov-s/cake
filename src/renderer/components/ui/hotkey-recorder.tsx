import { useEffect, useRef, useState } from "react";
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
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!recording) return;
    const keyDown = (event: globalThis.KeyboardEvent) => {
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
      const binding = hotkeyFromKeyboardEvent(event);
      if (!binding) return;
      onChange(binding);
      setRecording(false);
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target))
        setRecording(false);
    };
    window.addEventListener("keydown", keyDown, { capture: true });
    window.addEventListener("pointerdown", pointerDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", keyDown, { capture: true });
      window.removeEventListener("pointerdown", pointerDown, { capture: true });
    };
  }, [onChange, onClear, recording]);

  return (
    <div ref={container} className="flex shrink-0 items-center gap-1.5">
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
        onClick={(event) => {
          event.currentTarget.focus();
          setRecording(true);
        }}
        data-recording={recording ? "true" : undefined}
      >
        {recording ? "Press shortcut…" : formatHotkey(value)}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="px-2 text-[11px]"
        disabled={value === defaultValue}
        onClick={() => {
          onReset();
          setRecording(false);
        }}
      >
        Reset
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="px-2 text-[11px]"
        disabled={!value}
        onClick={() => {
          onClear();
          setRecording(false);
        }}
      >
        Clear
      </Button>
    </div>
  );
}
