import { Store, child, createStore } from "r-state-tree";
import type { Session } from "../models/Session";
import type { UiPart } from "../../ipc/session-contract";
import { toolOperationName } from "../../utils/cake-tool";
import {
  historicalSubagentRuns,
  subagentHandleFromTool,
  type SubagentRun,
} from "../../utils/subagent-runs";
import { ClientContext } from "./context/ClientContext";
import { ChatStore } from "./ChatStore";
import { SubagentHandleId } from "../../domain/subagents/subagent-data";

type ToolPart = Extract<UiPart, { kind: "tool" }>;

/** Owns live and historical subagent chats belonging to one parent session. */
export class SubagentActivityStore extends Store<{
  sessionId: string;
  model: Session;
  parts(): readonly UiPart[];
}> {
  get client() {
    return ClientContext.consume(this)!;
  }

  get runs(): SubagentRun[] {
    const runs = new Map(
      historicalSubagentRuns(this.props.parts()).map((run) => [run.key, run] as const),
    );
    for (const activity of this.props.model.subagentActivities) {
      runs.set(activity.handleId, {
        key: activity.handleId,
        anchorPartId: activity.anchorPartId,
        handleId: activity.handleId,
        task: activity.task,
        status: activity.status,
        resolvedModel: {
          ...activity.resolvedModel,
          fallbacks: [...activity.resolvedModel.fallbacks],
        },
        streaming: activity.streaming,
        parts: activity.parts,
        usage: activity.usage,
        error: activity.error,
        released: this.props.model.releasedSubagentHandleIds.includes(activity.handleId),
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

  private canMessage(key: string) {
    const run = this.run(key);
    return Boolean(run?.handleId && !run.released && run.status !== "queued");
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
        placeholder: () =>
          this.run(run.key)?.status === "running"
            ? "Steer this subagent…"
            : this.canMessage(run.key)
              ? "Message this subagent…"
              : "Subagent unavailable",
        inputLabel: () => "Message subagent",
        canSubmit: (draft) => this.canMessage(run.key) && Boolean(draft.trim()),
        submit: async (draft) => {
          const current = this.run(run.key);
          if (!current?.handleId || !this.canMessage(run.key)) return false;
          const input = {
            parentSessionId: this.props.sessionId,
            handleId: SubagentHandleId.make(current.handleId),
            text: draft.trim(),
          };
          if (current.status === "running")
            await this.client.subagents.steer(input, { signal: this.signal });
          else await this.client.subagents.prompt(input, { signal: this.signal });
          return true;
        },
        abort: async () => {
          const current = this.run(run.key);
          if (!current?.handleId || current.released) return;
          await this.client.subagents.abort(
            {
              parentSessionId: this.props.sessionId,
              handleId: SubagentHandleId.make(current.handleId),
            },
            { signal: this.signal },
          );
        },
        composerVisible: () => this.canMessage(run.key),
        usage: () => this.run(run.key)?.usage,
        error: () => ({ message: this.run(run.key)?.error }),
      }),
    );
  }

  chatStore(key: string) {
    return this.chatStores.find((chat) => chat.id === `subagent:${key}`);
  }
}
