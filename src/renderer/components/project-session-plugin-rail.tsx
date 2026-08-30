import { cn } from "@/lib/utils";
import { Slot, useHasSlotContributions } from "../plugin-runtime";

export function ProjectSessionPluginRail({ side }: { side: "left" | "right" }) {
  const topSlot = `project-session.${side}.top` as const;
  const middleSlot = `project-session.${side}.middle` as const;
  const bottomSlot = `project-session.${side}.bottom` as const;
  const hasContributions = useHasSlotContributions([topSlot, middleSlot, bottomSlot]);

  if (!hasContributions) return null;

  return (
    <aside
      className={cn(
        "grid w-[clamp(17.5rem,22cqi,21rem)] min-w-0 min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden bg-sidebar/38 p-3",
        side === "left" && "col-start-1 border-r border-border/72",
        side === "right" && "col-start-3 border-l border-border/72",
      )}
      aria-label={`${side === "left" ? "Left" : "Right"} session plugins`}
    >
      <div data-slot-content className="grid min-w-0 content-start gap-3 empty:hidden">
        <Slot name={topSlot} />
      </div>
      <div
        data-slot-content
        className="grid min-h-0 min-w-0 content-start gap-3 overflow-y-auto overscroll-contain empty:hidden"
      >
        <Slot name={middleSlot} />
      </div>
      <div data-slot-content className="grid min-w-0 content-start gap-3 empty:hidden">
        <Slot name={bottomSlot} />
      </div>
    </aside>
  );
}
