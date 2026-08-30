import { useEffect, useState } from "react";

const chevron = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

const orbitOrder = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, index) => {
  const order = orbitOrder.indexOf(index);
  return order === -1 ? null : order * 110;
});

const patterns = {
  Drive: { delays: chevron, duration: 650, round: false },
  Dots: { delays: chevron, duration: 650, round: true },
  Orbit: { delays: orbit, duration: 950, round: false },
} as const;

export type LoadingStateVariant = keyof typeof patterns;

export function formatElapsed(milliseconds: number) {
  const total = Math.max(0, milliseconds) / 1_000;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

export function LoadingState({
  label = "Churning",
  variant = "Drive",
  startedAt,
}: {
  label?: string;
  variant?: LoadingStateVariant;
  startedAt?: number;
}) {
  const [localStartedAt] = useState(() => Date.now());
  const effectiveStartedAt = startedAt ?? localStartedAt;
  const [now, setNow] = useState(() => Date.now());
  const { delays, duration, round } = patterns[variant];

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      data-slot="loading-state"
      className="flex w-fit items-center gap-2.5"
      role="status"
      aria-label={`${label} in progress`}
    >
      <span aria-hidden="true" className="grid grid-cols-[repeat(3,4px)] gap-[1.5px]">
        {delays.map((delay, index) => (
          <span
            key={index}
            data-slot="loading-state-cell"
            className={`size-[4px] bg-foreground motion-reduce:!animate-none ${round ? "rounded-full" : "rounded-[1px]"}`}
            style={{
              opacity: delay === null ? 0.07 : 0.15,
              animation:
                delay === null ? "none" : `pixel-on ${duration}ms ease-in-out ${delay}ms infinite`,
            }}
          />
        ))}
      </span>
      <span
        className="bg-clip-text text-[13px] font-medium text-transparent motion-reduce:!animate-none"
        style={{
          backgroundImage:
            "linear-gradient(90deg, var(--muted-foreground) 35%, var(--foreground) 50%, var(--muted-foreground) 65%)",
          backgroundSize: "200% 100%",
          animation: "shimmer-text 1.4s linear infinite",
        }}
      >
        {label}
      </span>
      <span className="font-mono text-[12px] text-muted-foreground tabular-nums">
        {formatElapsed(now - effectiveStartedAt)}
      </span>
    </div>
  );
}
