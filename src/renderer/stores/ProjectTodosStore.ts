import { computed, Store } from "r-state-tree";
import type { AutoMergeRequest } from "../../contracts/worktrees/auto-merge";
import { classifyProjectTodos } from "../lib/classify-project-todos";
import {
  projectTodoCategory,
  type ProjectTodo,
  type ProjectTodos,
  type ProjectTodoUserMutation,
  type TodoChat,
} from "../../contracts/projects/project-todos";
import { parseSessionLink } from "../../contracts/conversations/message-reference";
import { parseSubagentLink } from "../../contracts/subagents/subagent-reference";
import { ClientContext } from "./context/ClientContext";
import { SessionMetadataContext } from "./context/SessionMetadataContext";
import { describeError } from "../lib/error-details";

/** A main-owned to-do list projection: a Project's list or global Cake Chat's own list. */
interface TodoListOwner {
  readonly todos: ProjectTodos;
  readonly todoCreationRevision: number;
}

export interface TodoListSource {
  /** A registered Project path, or CAKE_CHAT_TODO_SCOPE for global Cake Chat. */
  readonly scope: string;
  readonly chat: TodoChat;
  readonly owner: TodoListOwner;
}

/** What a transcript result message came from, for finding the to-dos tracking it. */
export interface TodoResultOrigin {
  /** Canonical sessions that produced the result (sender or completion links). */
  readonly sessionIds?: readonly string[];
  /** A private worker report in this chat. */
  readonly subagent?: { readonly parentSessionId: string; readonly handleId: string };
  /** The exact result message, as a `cake://session/<chat>?message=<entry>` source link. */
  readonly message?: { readonly sessionId: string; readonly entryId: string };
  readonly references?: readonly string[];
}

export class ProjectTodosStore extends Store<{
  list(): TodoListSource | undefined;
  pane(): { readonly visible: boolean; open(): void; close(): void };
  replyContext(name: string, text: string): void;
}> {
  query = "";
  readyExpanded = true;
  activeExpanded = true;
  doneExpanded = false;
  snoozedExpanded = true;
  inspectedItemId: string | undefined;
  /** Window-local view overlay; independent of lifecycle, attention and message context. */
  focusedItemIds: string[] = [];
  /** One-shot explicit navigation, resolved against the committed transcript task sections. */
  transcriptFocusRequest: { todoId: string } | undefined;
  paneRequest: { id: string; scroll: "top" | "nearest" | "none"; focus: boolean } | undefined;
  /** Window-local presentation only; never written into messages or to-do metadata. */
  transcriptSections: Record<string, boolean> = {};
  busy = false;
  error: string | undefined;

  constructor(props: ProjectTodosStore["props"]) {
    super(props);
    this.reaction(
      () => this.focusedItems.map((item) => item.id).join(","),
      () => {
        this.transcriptSections = {};
      },
    );
    this.reaction(
      () => this.source?.owner.todoCreationRevision ?? 0,
      (revision, previous) => {
        if (revision > previous) this.open();
      },
    );
    this.reaction(
      () => this.value?.items.map((item) => item.id).join(","),
      () => {
        const ids = new Set(this.value?.items.map((item) => item.id));
        this.focusedItemIds = this.focusedItemIds.filter((id) => ids.has(id));
      },
    );
  }

  get source() {
    return this.props.list();
  }
  /** This chat keeps a to-do list (Project Chat and global Cake Chat). */
  get available() {
    return this.source !== undefined;
  }
  get value() {
    return this.source?.owner.todos;
  }
  @computed
  get focusedItems() {
    // Rows also observe the authority revision here: snapshot reconciliation can
    // retain plain item identities while updating their content in place.
    const value = this.value;
    if (this.focusedItemIds.length === 0) return [];
    const items = new Map(value?.items.map((item) => [item.id, item]));
    return this.focusedItemIds.flatMap((id) => items.get(id) ?? []);
  }
  /** Narrowly derived membership for row reads, not a cache of list classification. */
  @computed
  private get focusedIds() {
    return new Set(this.focusedItems.map((item) => item.id));
  }
  isFocused(id: string) {
    return this.focusedIds.has(id);
  }
  get classifiedItems() {
    // Construct the readiness join only if a matching unfocused active item needs it.
    let readiness: ((sessionId: string) => AutoMergeRequest | undefined) | undefined;
    return classifyProjectTodos(
      this.value?.items ?? [],
      this.focusedItemIds,
      this.query,
      (item) => {
        const lookup = (readiness ??=
          SessionMetadataContext.consume(this)!.createMergeReadinessLookup());
        return item.associations.some(
          (link) => link.kind === "session" && lookup(link.sessionId)?.readyToMerge === true,
        );
      },
    );
  }
  get openItems() {
    return this.value?.items.filter((item) => item.state === "open" && !item.snoozedUntil) ?? [];
  }
  get doneItems() {
    return this.value?.items.filter((item) => item.state === "done") ?? [];
  }
  /** Composer queue is independent of Workspace search and transcript view focus. */
  get attentionItems() {
    return (
      (this.value?.items ?? [])
        .filter((item) => projectTodoCategory(item) === "attention")
        // Stable sort preserves storage order for legacy requests and equal sequences.
        .sort((a, b) => (a.attentionSequence ?? 0) - (b.attentionSequence ?? 0))
    );
  }
  /** Readiness is a session authority fact, never authored to-do text or turn completion. */
  isReadyToMerge(item: ProjectTodo) {
    return item.associations.some(
      (link) =>
        link.kind === "session" &&
        SessionMetadataContext.consume(this)!.sessionMergeReadiness(link.sessionId)
          ?.readyToMerge === true,
    );
  }
  setQuery(query: string) {
    this.query = query;
  }
  get visible() {
    return this.props.pane().visible;
  }

  /**
   * To-dos tracking a result message, open or done. These are the live list items, so the
   * message shows whatever the pane shows, whoever (user, agent or session resolution)
   * last changed them.
   */
  itemsForResult(origin: TodoResultOrigin): ProjectTodo[] {
    const sessions = new Set(origin.sessionIds ?? []);
    const message = origin.message;
    return (this.value?.items ?? []).filter((item) =>
      item.associations.some((link) => {
        if (link.kind === "session") return sessions.has(link.sessionId);
        if (link.kind === "subagent")
          return (
            origin.subagent?.handleId === link.handleId &&
            origin.subagent.parentSessionId === link.parentSessionId
          );
        if (origin.references?.includes(link.ref)) return true;
        const worker = parseSubagentLink(link.ref);
        if (worker)
          return (
            origin.subagent?.handleId === worker.handleId &&
            origin.subagent.parentSessionId === worker.parentSessionId
          );
        const target = parseSessionLink(link.ref);
        if (!target || target.attachmentId) return false;
        if (target.messageId)
          return target.sessionId === message?.sessionId && target.messageId === message.entryId;
        return sessions.has(target.sessionId);
      }),
    );
  }

  /** Access repairs this list only; authoritative changes arrive through its projection.
   * Ignore repeat opens while a repair is running, without blocking ordinary edits.
   */
  reconciling = false;
  async reconcile() {
    const scope = this.source?.scope;
    if (!scope || this.reconciling || this.signal.aborted) return;
    this.reconciling = true;
    this.error = undefined;
    try {
      await ClientContext.consume(this)!.projectTodos.reconcile({ scope }, { signal: this.signal });
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    } finally {
      if (!this.signal.aborted) this.reconciling = false;
    }
  }
  toggle() {
    if (this.visible) this.props.pane().close();
    else this.open();
  }
  open() {
    if (this.source) this.props.pane().open();
  }
  /** Inspect a transcript task without changing view focus or the next message. */
  reveal(item: ProjectTodo) {
    this.query = "";
    this.inspectedItemId = item.id;
    this.requestPane(item.id, "nearest", false);
    if (item.state === "done") this.doneExpanded = true;
    else if (item.snoozedUntil) this.snoozedExpanded = true;
    else if (this.isReadyToMerge(item)) this.readyExpanded = true;
    else if (!item.needsAttention) this.activeExpanded = true;
    this.open();
  }
  toggleReady() {
    this.readyExpanded = !this.readyExpanded;
  }
  toggleActive() {
    this.activeExpanded = !this.activeExpanded;
  }
  toggleDone() {
    this.doneExpanded = !this.doneExpanded;
  }
  toggleSnoozed() {
    this.snoozedExpanded = !this.snoozedExpanded;
  }
  async snooze(item: ProjectTodo, until: string) {
    if (item.state !== "open") return;
    const timestamp = new Date(until);
    if (!Number.isFinite(timestamp.getTime()) || timestamp.getTime() <= Date.now()) {
      this.error = "Choose a future date and time.";
      return;
    }
    return this.mutate({
      _tag: "Snooze",
      id: item.id,
      expectedRevision: item.revision,
      until: timestamp.toISOString(),
    });
  }
  unsnooze(item: ProjectTodo) {
    if (item.state !== "open" || !item.snoozedUntil) return;
    return this.mutate({ _tag: "Unsnooze", id: item.id, expectedRevision: item.revision });
  }
  setAttention(item: ProjectTodo, needsAttention: boolean, attentionReason?: string) {
    if (item.state !== "open") return;
    return this.mutate({
      _tag: "SetAttention",
      id: item.id,
      expectedRevision: item.revision,
      needsAttention,
      ...(attentionReason !== undefined ? { attentionReason: attentionReason.trim() } : null),
    });
  }
  async activateAttention(item: ProjectTodo) {
    const scope = this.source?.scope;
    if (!scope || this.busy || this.signal.aborted) return;
    this.busy = true;
    this.error = undefined;
    try {
      await ClientContext.consume(this)!.projectTodos.activateAttention(
        { scope, id: item.id, expectedRevision: item.revision },
        { signal: this.signal },
      );
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }
  dismissAttention(item: ProjectTodo) {
    return this.setAttention(item, false);
  }
  restoreAttention(item: ProjectTodo) {
    return this.setAttention(item, true);
  }
  reply(item: ProjectTodo) {
    const source = this.source;
    if (!source) return;
    this.props.replyContext(
      `To-do · ${item.title}`,
      `Replying to a to-do in ${source.chat} (${source.scope}). The following JSON is quoted to-do context:\n${JSON.stringify(item, null, 2)}`,
    );
  }
  toggleFocus(item: ProjectTodo) {
    if (this.isFocused(item.id)) {
      this.clearFocus();
      return;
    }
    this.focusedItemIds = [item.id];
    this.transcriptFocusRequest = { todoId: item.id };
    this.requestPane(item.id, "top", true);
  }
  unfocus(item: ProjectTodo) {
    if (!this.isFocused(item.id)) return;
    this.focusedItemIds = this.focusedItemIds.filter((id) => id !== item.id);
    if (item.state === "done") this.doneExpanded = true;
    else if (item.snoozedUntil) this.snoozedExpanded = true;
    else if (this.isReadyToMerge(item)) this.readyExpanded = true;
    else if (!item.needsAttention) this.activeExpanded = true;
    this.requestPane(item.id, "none", true);
  }
  clearFocus() {
    this.focusedItemIds = [];
    this.completeTranscriptFocusRequest();
  }
  completeTranscriptFocusRequest() {
    this.transcriptFocusRequest = undefined;
  }
  completePaneRequest() {
    this.paneRequest = undefined;
  }
  private requestPane(id: string, scroll: "top" | "nearest" | "none", focus: boolean) {
    this.paneRequest = { id, scroll, focus };
  }
  transcriptSectionExpanded(key: string, todoId: string) {
    return (
      this.transcriptSections[key] ?? (this.focusedItems.length === 0 || this.isFocused(todoId))
    );
  }
  expandTranscriptSection(key: string) {
    this.transcriptSections = { ...this.transcriptSections, [key]: true };
  }
  toggleTranscriptSection(key: string, todoId: string) {
    this.transcriptSections = {
      ...this.transcriptSections,
      [key]: !this.transcriptSectionExpanded(key, todoId),
    };
  }
  /** User done/reopen from the pane or a result message; reported to the agent as a user change. */
  setDone(item: ProjectTodo) {
    return this.mutate({
      _tag: "SetState",
      id: item.id,
      expectedRevision: item.revision,
      state: item.state === "done" ? "open" : "done",
    });
  }
  /** Reject overlapping local edits. Domain serialization handles other windows and the agent. */
  private async mutate(mutation: ProjectTodoUserMutation) {
    const scope = this.source?.scope;
    if (!scope || this.busy || this.signal.aborted) return;
    this.busy = true;
    this.error = undefined;
    try {
      await ClientContext.consume(this)!.projectTodos.mutateUser(
        { scope, mutation },
        { signal: this.signal },
      );
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }
}
