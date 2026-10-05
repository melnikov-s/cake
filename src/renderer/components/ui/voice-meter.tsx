import type { CSSProperties } from "react";

const barWeights = [0.45, 0.7, 0.95, 0.65, 1, 0.8, 0.5];
type BarStyle = CSSProperties & { "--voice-bar-scale": number };

/** Decorative microphone-level display. No simulated animation or audio ownership. */
export function VoiceMeter({ level }: { level: number }) {
  const boundedLevel = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  return (
    <span
      aria-hidden="true"
      data-slot="voice-meter"
      className="flex h-5 items-center gap-1 text-primary"
    >
      {barWeights.map((weight, index) => {
        const style: BarStyle = { "--voice-bar-scale": 0.18 + boundedLevel * weight * 0.82 };
        return (
          <span
            key={index}
            data-slot="voice-meter-bar"
            className="h-4 w-0.5 scale-y-(--voice-bar-scale) rounded-full bg-current motion-safe:transition-transform motion-safe:duration-75 motion-safe:ease-out"
            style={style}
          />
        );
      })}
    </span>
  );
}
