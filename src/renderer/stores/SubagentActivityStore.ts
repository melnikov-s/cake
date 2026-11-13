import {
  Store,
  child,
  computed,
  createStore,
  effect as reactiveEffect,
  type ReadonlySignal,
} from "r-state-tree";
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

interface WorkerChat {
  handleId: string;
  queued: boolean;
  messageable: boolean;
}

interface WorkerChildren {
  attachments: string[];
  chats: WorkerChat[];
}

/**
 * A parent report with a handle but no live worker. Its explanation is read
 * lazily, so a loading-state flip never invalidates run identity or chat lists.
 */
function unmappedRun(run: SubagentRun, model: SubagentCatalog): SubagentRun {
  return {
    ...run,
    parts: [],
    get error() {
      return (
        model.observationError ??
        (model.loaded
          ? "The full subagent conversation is unavailable: Cake has no retained handle-to-Pi mapping for this worker. A parent report cannot safely recover its identity."
          : "The saved subagent conversation is still loading.")
      );
    },
  };
}

/** Owns live and historical subagent chats belonging to one parent session. */
export class SubagentActivityStore extends Store<{
  sessionId: string;
  model: SubagentCatalog;
  parts(): readonly UiPart[];
  /** The owning chat's focused to-dos while its panel is open; absent elsewhere. */
  focusedTodos?(): readonly ProjectTodo[];
}> {
  private commandErrors: Record<string, string | undefined> = {};
  /** Last child element per worker chat, reused while its chat is unchanged. */
  private readonly chatElements = new Map<string, { signature: string; element: ChatStore }>();

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

  /** Parsing the parent transcript depends only on its parts. */
  @computed
  private get historicalRuns(): readonly SubagentRun[] {
    return historicalSubagentRuns(this.props.parts());
  }

  @computed
  get runs(): SubagentRun[] {
    const { model } = this.props;
    const released = new Set(model.releasedHandleIds);
    const runs = new Map<string, SubagentRun>();
    for (const historical of this.historicalRuns) {
      let run =
        historical.handleId && released.has(historical.handleId)
          ? { ...historical, released: true }
          : historical;
      // Parent reports establish navigation/labels, never a substitute transcript.
      if (run.handleId && !run.failurePhase) run = unmappedRun(run, model);
      runs.set(run.key, run);
    }
    for (const activity of model.activities) {
      const isReleased = released.has(activity.handleId);
      runs.set(activity.handleId, {
        key: activity.handleId,
        anchorPartId: activity.anchorPartId,
        handleId: activity.handleId,
        task: activity.task,
        ...(activity.title ? { title: activity.title } : null),
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
        released: isReleased,
        available: !isReleased,
      });
    }
    return [...runs.values()];
  }

  @computed
  private get runsByKey(): ReadonlyMap<string, SubagentRun> {
    return new Map(this.runs.map((run) => [run.key, run]));
  }

  @computed
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
    return this.runsByKey.get(key);
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
        .focusedTodos?.()
        ?.some((todo) =>
          todo.associations.some(
            (association) =>
              association.kind === "subagent" &&
              association.parentSessionId === this.props.sessionId &&
              association.handleId === run.handleId,
          ),
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

  /** Memoized per worker: one run's change never re-notifies other workers' composers. */
  private readonly messageable = new Map<string, ReadonlySignal<boolean>>();

  private canMessage(key: string) {
    let messageable = this.messageable.get(key);
    if (!messageable) {
      messageable = computed(() => {
        const run = this.run(key);
        return Boolean(run?.handleId && run.available && !run.failurePhase);
      });
      this.messageable.set(key, messageable);
    }
    return messageable.value;
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
    operation: "remove" | "steer" | "send-now" | "reorder" | "update",
    position?: number,
    text?: string,
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
          ...(text === undefined ? null : { text }),
          ...(position === undefined ? null : { position }),
          ...(entry.itemId ? { itemId: entry.itemId } : null),
        },
        { signal: this.signal },
      );
      return true;
    });
  }

  /**
   * Child Store lists depend on this summary, not on every run update. A JSON
   * signature makes an unchanged summary an equal value, so streaming parts or a
   * running→complete status never re-create or re-prop the child Stores.
   */
  @computed
  private get workerChildrenSignature(): string {
    const children: WorkerChildren = {
      attachments: this.runs.flatMap((run) => (run.handleId ? [run.handleId] : [])),
      chats: this.runs.flatMap((run) =>
        run.handleId && !run.failurePhase
          ? [
              {
                handleId: run.handleId,
                queued: run.status === "queued",
                messageable: this.canMessage(run.key),
              },
            ]
          : [],
      ),
    };
    return JSON.stringify(children);
  }

  @computed
  private get workerChildren(): WorkerChildren {
    // SAFETY: the signature is JSON.stringify of a WorkerChildren value built above.
    return JSON.parse(this.workerChildrenSignature) as WorkerChildren;
  }

  @child
  get attachmentImageStores(): TranscriptAttachmentImagesStore[] {
    return this.workerChildren.attachments.map((handleId) =>
      createStore(TranscriptAttachmentImagesStore, {
        key: handleId,
        read: (reference, signal) =>
          this.client.subagents.readAttachment(
            {
              parentSessionId: this.parentSessionId,
              handleId: SubagentHandleId.make(handleId),
              reference: reference.id,
            },
            { signal },
          ),
      }),
    );
  }

  @computed
  private get attachmentImageStoresByKey(): ReadonlyMap<string, TranscriptAttachmentImagesStore> {
    // Tracking membership reconciles new Stores synchronously, even inside a batch.
    void this.workerChildren.attachments;
    return new Map(this.attachmentImageStores.map((store) => [String(store.key), store]));
  }

  @child
  get chatStores(): ChatStore[] {
    const chats = this.workerChildren.chats;
    const keys = new Set(chats.map(({ handleId }) => handleId));
    for (const key of this.chatElements.keys()) if (!keys.has(key)) this.chatElements.delete(key);
    return chats.map((chat) => {
      // Reusing an unchanged chat's element keeps its props identical, so one
      // worker's queued/messaging change never re-notifies the other workers' chats.
      const signature = JSON.stringify(chat);
      const cached = this.chatElements.get(chat.handleId);
      if (cached?.signature === signature) return cached.element;
      const element = this.chatElement(chat);
      this.chatElements.set(chat.handleId, { signature, element });
      return element;
    });
  }

  private chatElement(chat: WorkerChat): ChatStore {
    // Historical and live runs with a handle are keyed by that handle.
    const run = { ...chat, key: chat.handleId };
    return createStore(ChatStore, {
      key: run.key,
      id: () => `subagent:${run.key}`,
      parts: () => this.run(run.key)?.parts ?? [],
      attachmentImages: () => this.attachmentImageStoresByKey.get(run.key)!,
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
      userMessagePresentation: run.messageable
        ? {
            setMarkdown: (entryId, renderAsMarkdown) =>
              this.client.subagents.setUserMessageMarkdown(
                {
                  parentSessionId: this.props.sessionId,
                  handleId: SubagentHandleId.make(run.handleId),
                  entryId,
                  renderAsMarkdown,
                },
                { signal: this.signal },
              ),
          }
        : undefined,
      queuedPrompts: () =>
        this.canMessage(run.key) ? queuedPrompts(this.run(run.key)?.parts ?? []) : [],
      steerQueuedPrompt: run.queued
        ? undefined
        : async (id) => {
            await this.editQueue(run.key, id, "steer");
          },
      stopAndSendQueuedPrompt: run.queued
        ? undefined
        : async (id) => {
            await this.editQueue(run.key, id, "send-now");
          },
      reorderQueuedPrompt: run.queued
        ? undefined
        : async (id, position) => {
            await this.editQueue(run.key, id, "reorder", position);
          },
      removeQueuedPrompt: (id) => {
        void this.editQueue(run.key, id, "remove");
      },
      editQueuedPrompt: (id, text) => this.editQueue(run.key, id, "update", undefined, text),
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
    });
  }

  /** Chat membership only; another worker's messaging flip leaves it equal. */
  @computed
  private get chatKeySignature(): string {
    return JSON.stringify(this.workerChildren.chats.map(({ handleId }) => handleId));
  }

  @computed
  private get chatStoresByKey(): ReadonlyMap<string, ChatStore> {
    // Tracking membership reconciles new chats synchronously, even inside a batch.
    void this.chatKeySignature;
    return new Map(this.chatStores.map((chat) => [String(chat.key), chat]));
  }

  chatStore(key: string) {
    return this.chatStoresByKey.get(key);
  }

  /** The worker run displayed by one of this parent's chats. */
  runForChat(chat: ChatStore) {
    const key = chat.key === undefined ? undefined : String(chat.key);
    return key !== undefined && this.chatStoresByKey.get(key) === chat ? this.run(key) : undefined;
  }
}
