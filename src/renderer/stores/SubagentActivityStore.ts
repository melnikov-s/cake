import { Store, child, createStore, effect as reactiveEffect } from "r-state-tree";
import type { SubagentCatalog } from "../models/SubagentCatalog";
import type { UiPart } from "../../contracts/conversations/session-contract";
import { toolOperationName } from "../../utils/cake-tool";
import {
  historicalSubagentRuns,
  subagentHandleFromTool,
  type SubagentRun,
} from "../../utils/subagent-runs";
import type { ProjectTodo } from "../../contracts/projects/project-todos";
import { ClientContext } from "./context/ClientContext";
import { ChatStore } from "./ChatStore";
import { queuedPrompts } from "../lib/queued-prompts";
import { TranscriptAttachmentImagesStore } from "./TranscriptAttachmentImagesStore";
import { SubagentHandleId } from "../../contracts/subagents/subagent-data";
import type { SideChatModel } from "./SideChatStore";

type ToolPart = Extract<UiPart, { kind: "tool" }>;

/** Owns live and historical subagent chats belonging to one parent session. */
export class SubagentActivityStore extends Store<{
  sessionId: string;
  model: SubagentCatalog;
  parts(): readonly UiPart[];
  /** The owning Project Chat's to-do selection while its panel is open; absent elsewhere. */
  selectedTodo?(): ProjectTodo | undefined;
}> {
  private commandErrors: Record<string, string | undefined> = {};

  get client() {
    return ClientContext.consume(this)!;
  }

  get parentSessionId() {
    return this.props.sessionId;
  }

  resourceContext(
    key: string,
  ): { parentSessionId: string; handleId: SubagentHandleId; workspacePath?: string } | undefined {
    const run = this.run(key);
    if (!run?.handleId) return undefined;
    const activity = this.props.model.activities.find(
      (activity) => activity.handleId === run.handleId,
    );
    if (!activity) return undefined;
    return {
      parentSessionId: this.parentSessionId,
      handleId: SubagentHandleId.make(run.handleId),
      ...(activity.projectPath ? { workspacePath: activity.projectPath } : null),
    };
  }

  get runs(): SubagentRun[] {
    const runs = new Map(
      historicalSubagentRuns(this.props.parts()).map((run) => [run.key, run] as const),
    );
    for (const run of runs.values()) {
      if (run.handleId && this.props.model.releasedHandleIds.includes(run.handleId))
        run.released = true;
      // Parent reports establish navigation/labels, never a substitute transcript.
      if (run.handleId && !run.failurePhase) {
        run.parts = [];
        run.error =
          this.props.model.observationError ??
          (this.props.model.loaded
            ? "The full subagent conversation is unavailable: Cake has no retained handle-to-Pi mapping for this worker. A parent report cannot safely recover its identity."
            : "The saved subagent conversation is still loading.");
      }
    }
    for (const activity of this.props.model.activities) {
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
        fastMode: activity.fastMode,
        streaming: activity.streaming,
        parts: activity.parts,
        usage: activity.usage,
        error: activity.error,
        failurePhase: activity.failurePhase,
        released: this.props.model.releasedHandleIds.includes(activity.handleId),
        available: !this.props.model.releasedHandleIds.includes(activity.handleId),
      });
    }
    return [...runs.values()];
  }

  get activeRuns() {
    return this.runs.filter(
      (run) => run.available && (run.status === "queued" || run.status === "running"),
    );
  }

  /** Deep links can arrive before this parent's independent worker projection. */
  ready(): Promise<void> {
    if (this.props.model.observationError)
      return Promise.reject(new Error(this.props.model.observationError));
    if (this.props.model.loaded) return Promise.resolve();
    if (this.signal.aborted) return Promise.reject(new Error("Subagent navigation was canceled"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: string) => {
        if (settled) return;
        settled = true;
        this.signal.removeEventListener("abort", abort);
        dispose();
        if (error) reject(new Error(error));
        else resolve();
      };
      const abort = () => finish("Subagent navigation was canceled");
      this.signal.addEventListener("abort", abort, { once: true });
      const dispose = reactiveEffect(() => {
        const { loaded, observationError } = this.props.model;
        if (observationError || loaded) queueMicrotask(() => finish(observationError));
      });
    });
  }

  run(key: string) {
    return this.runs.find((run) => run.key === key);
  }

  /** The model the worker was started on, as resolved by the backend. */
  model(key: string): SideChatModel | undefined {
    const run = this.run(key);
    if (!run?.resolvedModel) return undefined;
    return {
      provider: run.resolvedModel.provider,
      modelId: run.resolvedModel.modelId,
      thinkingLevel: run.resolvedModel.thinkingLevel,
      fastMode: run.fastMode ?? false,
    };
  }

  isAssociated(key: string) {
    const run = this.run(key);
    return Boolean(
      run?.handleId &&
      this.props
        .selectedTodo?.()
        ?.associations.some(
          (association) =>
            association.kind === "subagent" &&
            association.parentSessionId === this.props.sessionId &&
            association.handleId === run.handleId,
        ),
    );
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
    return Boolean(run?.handleId && run.available && !run.failurePhase);
  }

  private async command<T>(key: string, run: (handleId: SubagentHandleId) => Promise<T>) {
    if (!this.canMessage(key)) return false;
    this.commandErrors = { ...this.commandErrors, [key]: undefined };
    try {
      return await run(SubagentHandleId.make(this.run(key)!.handleId!));
    } catch (error) {
      if (!this.signal.aborted)
        this.commandErrors = {
          ...this.commandErrors,
          [key]: error instanceof Error ? error.message : String(error),
        };
      return false;
    }
  }

  private async editQueue(
    key: string,
    partId: string,
    operation: "remove" | "steer" | "send-now" | "reorder",
    position?: number,
  ) {
    const entry = queuedPrompts(this.run(key)?.parts ?? []).find((item) => item.id === partId);
    if (!entry) return false;
    return this.command(key, async (handleId) => {
      await this.client.subagents.editQueued(
        {
          parentSessionId: this.props.sessionId,
          handleId,
          partId,
          operation,
          ...(position === undefined ? null : { position }),
          ...(entry.itemId ? { itemId: entry.itemId } : null),
        },
        { signal: this.signal },
      );
      return true;
    });
  }

  @child
  get attachmentImageStores(): TranscriptAttachmentImagesStore[] {
    return this.runs
      .filter((run) => run.handleId)
      .map((run) =>
        createStore(TranscriptAttachmentImagesStore, {
          key: run.key,
          read: (reference, signal) =>
            this.client.subagents.readAttachment(
              {
                parentSessionId: this.parentSessionId,
                handleId: SubagentHandleId.make(run.handleId!),
                reference: reference.id,
              },
              { signal },
            ),
        }),
      );
  }

  @child
  get chatStores(): ChatStore[] {
    return this.runs
      .filter((run) => run.handleId && !run.failurePhase)
      .map((run) =>
        createStore(ChatStore, {
          key: run.key,
          id: () => `subagent:${run.key}`,
          parts: () => this.run(run.key)?.parts ?? [],
          attachmentImages: () =>
            this.attachmentImageStores[
              this.runs.filter((run) => run.handleId).findIndex((entry) => entry.key === run.key)
            ]!,
          streaming: () => {
            const current = this.run(run.key);
            return Boolean(
              current &&
              !current.released &&
              (current.status === "running" || current.status === "queued"),
            );
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
            this.run(run.key)?.status === "running" || this.run(run.key)?.status === "queued"
              ? "Queue a message…"
              : this.canMessage(run.key)
                ? "Message this subagent…"
                : "Subagent unavailable",
          inputLabel: () => "Message subagent",
          canSubmit: (draft) => this.canMessage(run.key) && Boolean(draft.trim()),
          submit: (draft, options) =>
            this.command(run.key, (handleId) =>
              this.client.subagents.submit(
                {
                  parentSessionId: this.props.sessionId,
                  handleId,
                  text: draft.trim(),
                  renderUserMessageAsMarkdown: options?.renderUserMessageAsMarkdown ?? false,
                },
                { signal: this.signal },
              ),
            ),
          userMessagePresentation: this.canMessage(run.key)
            ? {
                setMarkdown: (entryId, renderAsMarkdown) =>
                  this.client.subagents.setUserMessageMarkdown(
                    {
                      parentSessionId: this.props.sessionId,
                      handleId: SubagentHandleId.make(run.handleId!),
                      entryId,
                      renderAsMarkdown,
                    },
                    { signal: this.signal },
                  ),
              }
            : undefined,
          queuedPrompts: () =>
            this.canMessage(run.key) ? queuedPrompts(this.run(run.key)?.parts ?? []) : [],
          steerQueuedPrompt:
            run.status === "queued"
              ? undefined
              : async (id) => {
                  await this.editQueue(run.key, id, "steer");
                },
          stopAndSendQueuedPrompt:
            run.status === "queued"
              ? undefined
              : async (id) => {
                  await this.editQueue(run.key, id, "send-now");
                },
          reorderQueuedPrompt:
            run.status === "queued"
              ? undefined
              : async (id, position) => {
                  await this.editQueue(run.key, id, "reorder", position);
                },
          removeQueuedPrompt: (id) => {
            void this.editQueue(run.key, id, "remove");
          },
          editQueuedPrompt: async (id) => {
            const entry = queuedPrompts(this.run(run.key)?.parts ?? []).find(
              (item) => item.id === id,
            );
            if (!entry?.editable || !(await this.editQueue(run.key, id, "remove"))) return;
            this.chatStore(run.key)?.setDraft(entry.text);
          },
          abort: async () => {
            const current = this.run(run.key);
            if (!current?.handleId || current.released) return;
            await this.command(run.key, (handleId) =>
              this.client.subagents.abort(
                { parentSessionId: this.props.sessionId, handleId },
                { signal: this.signal },
              ),
            );
          },
          composerVisible: () => this.canMessage(run.key),
          usage: () => this.run(run.key)?.usage,
          error: () => ({ message: this.commandErrors[run.key] ?? this.run(run.key)?.error }),
        }),
      );
  }

  chatStore(key: string) {
    return this.chatStores.find((chat) => chat.id === `subagent:${key}`);
  }
}
