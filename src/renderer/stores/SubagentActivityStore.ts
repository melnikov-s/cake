import { Store, child, createStore, observable } from "r-state-tree";
import type { SubagentActivity } from "../desktop-client";
import type { UiPart } from "../../ipc/session-contract";
import { toolOperationName } from "../../utils/cake-tool";
import {
  historicalSubagentRuns,
  subagentHandleFromTool,
  type SubagentRun,
} from "../../utils/subagent-runs";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import { ChatStore } from "./ChatStore";

type ToolPart = Extract<UiPart, { kind: "tool" }>;

/** Owns live and historical subagent chats belonging to one parent session. */
export class SubagentActivityStore extends Store<{
  sessionId: string;
  client: DesktopClient;
  parts(): readonly UiPart[];
}> {
  private readonly activitiesByHandle: Record<string, SubagentActivity> = observable({});
  private readonly releasedHandles: Set<string> = observable(new Set<string>());

  receive(event: DesktopClientEvent) {
    if (event.type === "subagent-activity-received") {
      const activity = event.activity;
      if (activity.parentSessionId !== this.props.sessionId) return;
      const current = this.activitiesByHandle[activity.handleId];
      if (current && current.revision >= activity.revision) return;
      this.activitiesByHandle[activity.handleId] = activity;
      this.releasedHandles.delete(activity.handleId);
      return;
    }
    if (
      event.type === "subagent-activity-removed" &&
      event.parentSessionId === this.props.sessionId
    )
      this.releasedHandles.add(event.handleId);
  }

  get runs(): SubagentRun[] {
    const runs = new Map(
      historicalSubagentRuns(this.props.parts()).map((run) => [run.key, run] as const),
    );
    for (const activity of Object.values(this.activitiesByHandle)) {
      runs.set(activity.handleId, {
        key: activity.handleId,
        anchorPartId: activity.anchorPartId,
        handleId: activity.handleId,
        task: activity.task,
        profile: activity.profile,
        status: activity.status,
        resolvedModel: activity.resolvedModel,
        streaming: activity.streaming,
        parts: activity.parts,
        usage: activity.usage,
        error: activity.error,
        released: this.releasedHandles.has(activity.handleId),
      });
    }
    return [...runs.values()];
  }

  get activeRuns() {
    return this.runs.filter(
      (run) => !run.released && (run.status === "queued" || run.status === "running"),
    );
  }

  run(key: string) {
    return this.runs.find((run) => run.key === key);
  }

  runsForTool(part: ToolPart, startPart?: ToolPart) {
    const anchorPartId = startPart?.id ?? part.id;
    if (toolOperationName(part) === "subagents.parallel")
      return this.runs.filter((run) => run.anchorPartId === anchorPartId);
    const handleId = subagentHandleFromTool(part) ?? subagentHandleFromTool(startPart);
    const run = handleId ? this.run(handleId) : undefined;
    return run ? [run] : this.runs.filter((candidate) => candidate.anchorPartId === anchorPartId);
  }

  private canSteer(key: string) {
    const run = this.run(key);
    return Boolean(run?.handleId && !run.released && run.status === "running" && run.streaming);
  }

  @child
  get chatStores(): ChatStore[] {
    return this.runs.map((run) =>
      createStore(ChatStore, {
        key: run.key,
        id: () => `subagent:${run.key}`,
        parts: () => this.run(run.key)?.parts ?? [],
        streaming: () => {
          const current = this.run(run.key);
          return Boolean(current && !current.released && current.status === "running");
        },
        submitting: () => false,
        stoppable: () => {
          const current = this.run(run.key);
          return Boolean(
            current &&
            !current.released &&
            (current.status === "queued" || current.status === "running"),
          );
        },
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => (this.canSteer(run.key) ? "Steer this subagent…" : "Subagent released"),
        inputLabel: () => "Steer subagent",
        canSubmit: (draft) => this.canSteer(run.key) && Boolean(draft.trim()),
        submit: async (draft) => {
          const current = this.run(run.key);
          if (!current?.handleId || !this.canSteer(run.key)) return false;
          await this.props.client.steerSubagent({
            parentSessionId: this.props.sessionId,
            handleId: current.handleId,
            text: draft.trim(),
          });
          return true;
        },
        abort: async () => {
          const current = this.run(run.key);
          if (!current?.handleId || current.released) return;
          await this.props.client.abortSubagent({
            parentSessionId: this.props.sessionId,
            handleId: current.handleId,
          });
        },
        composerVisible: () => this.canSteer(run.key),
        usage: () => this.run(run.key)?.usage,
        error: () => ({ message: this.run(run.key)?.error }),
      }),
    );
  }

  chatStore(key: string) {
    return this.chatStores.find((chat) => chat.id === `subagent:${key}`);
  }
}
