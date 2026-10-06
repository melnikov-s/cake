import type { CSSProperties } from "react";
import { cn } from "../../lib/utils";

const barWeights = [0.45, 0.7, 0.95, 0.65, 1, 0.8, 0.5];
type BarStyle = CSSProperties & { "--voice-bar-scale": number };

/** Decorative microphone-level display. No simulated animation or audio ownership. */
export function VoiceMeter({
  level,
  size = "default",
}: {
  level: number;
  size?: "default" | "sm";
}) {
  const boundedLevel = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  return (
    <span
      aria-hidden="true"
      data-slot="voice-meter"
      className={cn("flex items-center", size === "sm" ? "h-3 gap-px" : "h-5 gap-1 text-primary")}
    >
      {barWeights.map((weight, index) => {
        const style: BarStyle = { "--voice-bar-scale": 0.18 + boundedLevel * weight * 0.82 };
        return (
          <span
            key={index}
            data-slot="voice-meter-bar"
            className={cn(
              "scale-y-(--voice-bar-scale) rounded-full bg-current motion-safe:transition-transform motion-safe:duration-75 motion-safe:ease-out",
              size === "sm" ? "h-3 w-px" : "h-4 w-0.5",
            )}
            style={style}
          />
        );
      })}
    </span>
  );
}
