import { Store, observable } from "r-state-tree";
import type { SubagentActivity } from "../../ipc/subagent-activity-contract";
import type { DesktopClientEvent } from "../desktop-client";

/** Owns the transient live projection of subagents belonging to one parent session. */
export class SubagentActivityStore extends Store<{ sessionId: string }> {
  private readonly activitiesByHandle: Record<string, SubagentActivity> = observable({});

  receive(event: DesktopClientEvent) {
    if (event.type === "subagent-activity-received") {
      const activity = event.activity;
      if (activity.parentSessionId !== this.props.sessionId) return;
      const current = this.activitiesByHandle[activity.handleId];
      if (current && current.revision >= activity.revision) return;
      this.activitiesByHandle[activity.handleId] = activity;
      return;
    }
    if (
      event.type === "subagent-activity-removed" &&
      event.parentSessionId === this.props.sessionId
    )
      delete this.activitiesByHandle[event.handleId];
  }

  forHandle(handleId: string | undefined) {
    return handleId ? this.activitiesByHandle[handleId] : undefined;
  }

  forAnchor(anchorPartId: string) {
    return Object.values(this.activitiesByHandle).filter(
      (activity) => activity.anchorPartId === anchorPartId,
    );
  }
}
