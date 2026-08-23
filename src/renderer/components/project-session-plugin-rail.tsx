import { Slot } from "../plugin-runtime";

export function ProjectSessionPluginRail({ side }: { side: "left" | "right" }) {
  return (
    <aside
      className={`project-session-plugin-rail project-session-plugin-rail-${side}`}
      aria-label={`${side === "left" ? "Left" : "Right"} session plugins`}
    >
      <div className="plugin-slot project-session-rail-slot project-session-rail-slot-top">
        <Slot name={`project-session.${side}.top`} />
      </div>
      <div className="plugin-slot project-session-rail-slot project-session-rail-slot-middle">
        <Slot name={`project-session.${side}.middle`} />
      </div>
      <div className="plugin-slot project-session-rail-slot project-session-rail-slot-bottom">
        <Slot name={`project-session.${side}.bottom`} />
      </div>
    </aside>
  );
}
