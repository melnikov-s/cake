import { cn } from "@/lib/utils";
import { Slot } from "../plugin-runtime";

export function ProjectSessionPluginRail({ side }: { side: "left" | "right" }) {
  const topSlot = `project-session.${side}.top` as const;
  const middleSlot = `project-session.${side}.middle` as const;
  const bottomSlot = `project-session.${side}.bottom` as const;

  return (
    <aside
      className={cn(
        "hidden w-[clamp(17.5rem,22cqi,21rem)] min-w-0 min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden bg-sidebar/38 p-3 has-[>[data-slot-content]:not(:empty)]:grid",
        side === "left" &&
          "col-start-1 border-r border-border/72 max-[1100px]:row-start-2 max-[1100px]:w-full max-[1100px]:border-r-0 max-[1100px]:border-t",
        side === "right" &&
          "col-start-3 border-l border-border/72 max-[1100px]:col-start-1 max-[1100px]:row-start-3 max-[1100px]:w-full max-[1100px]:border-l-0 max-[1100px]:border-t",
      )}
      aria-label={`${side === "left" ? "Left" : "Right"} session plugins`}
    >
      <div
        data-slot-content
        className="grid min-w-0 content-start gap-3 empty:hidden [&>*]:max-w-full"
      >
        <Slot name={topSlot} />
      </div>
      <div
        data-slot-content
        className="grid min-h-0 min-w-0 content-start gap-3 overflow-y-auto overscroll-contain empty:hidden [&>*]:max-w-full"
      >
        <Slot name={middleSlot} />
      </div>
      <div
        data-slot-content
        className="grid min-w-0 content-start gap-3 empty:hidden [&>*]:max-w-full"
      >
        <Slot name={bottomSlot} />
      </div>
    </aside>
  );
}
