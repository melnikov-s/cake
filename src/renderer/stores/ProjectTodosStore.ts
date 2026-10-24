import { Store, computed } from "r-state-tree";
import type { UiPart } from "../../contracts/conversations/session-contract";
import { resultTodoOrigin } from "../lib/result-todo-origin";
import {
  type ProjectTodo,
  type ProjectTodos,
  type ProjectTodoUserMutation,
  type TodoChat,
} from "../../contracts/projects/project-todos";
import { parseSessionLink } from "../../contracts/conversations/message-reference";
import { parseSubagentLink } from "../../contracts/subagents/subagent-reference";
import { ClientContext } from "./context/ClientContext";
import type { SideChatStore } from "./SideChatStore";
import { describeError } from "../lib/error-details";

/** A main-owned to-do list projection: a Project's list or global Cake Chat's own list. */
interface TodoListOwner {
  readonly todos: ProjectTodos;
  readonly selectedTodo: ProjectTodo | undefined;
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
}

export class ProjectTodosStore extends Store<{
  list(): TodoListSource | undefined;
  sidePanel(): SideChatStore;
  /** The owning chat's transcript, for placing Done controls on result messages. */
  transcript?(): { readonly chatSessionId: string; readonly parts: readonly UiPart[] };
}> {
  query = "";
  doneExpanded = false;
  busy = false;
  error: string | undefined;

  constructor(props: ProjectTodosStore["props"]) {
    super(props);
    this.reaction(
      () => this.source?.owner.todoCreationRevision ?? 0,
      (revision, previous) => {
        if (revision > previous) this.open();
      },
    );
    // A selection lives only while this panel shows it. Closing the panel clears it, once any
    // in-flight edit settles. Tracking only this store's own state keeps another window, whose
    // panel is closed, from clearing a selection made here.
    this.reaction(
      () => this.visible || this.busy,
      (holding) => {
        if (!holding && this.value?.selectedId)
          void this.mutate({ _tag: "Select", selectedId: null });
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
  /** The selected open to-do, only while the to-do panel is open. */
  get selectedItem() {
    return this.visible ? this.source?.owner.selectedTodo : undefined;
  }
  get openItems() {
    return this.value?.items.filter((item) => item.state === "open") ?? [];
  }
  get doneItems() {
    return this.value?.items.filter((item) => item.state === "done") ?? [];
  }
  get filteredItems() {
    const query = this.query.trim().toLowerCase();
    return (this.value?.items ?? []).filter(
      (item) =>
        !query ||
        item.title.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query),
    );
  }
  get filteredOpenItems() {
    return this.filteredItems.filter((item) => item.state === "open");
  }
  get filteredDoneItems() {
    return this.filteredItems.filter((item) => item.state === "done");
  }
  setQuery(query: string) {
    this.query = query;
  }
  get visible() {
    return this.props.sidePanel().target?.key === "project-todos";
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
        const worker = parseSubagentLink(link.ref);
        if (worker)
          return (
            origin.subagent?.handleId === worker.handleId &&
            origin.subagent.parentSessionId === worker.parentSessionId
          );
        const target = parseSessionLink(link.ref);
        if (!target || target.attachmentId) return false;
        if (message && target.sessionId === message.sessionId)
          return target.messageId === message.entryId;
        return sessions.has(target.sessionId);
      }),
    );
  }

  /**
   * Which result message shows each to-do's Done control: only the latest linked result in
   * the transcript, so a session's earlier progress updates don't repeat the control.
   */
  @computed
  get resultControls(): ReadonlyMap<string, readonly ProjectTodo[]> {
    const transcript = this.props.transcript?.();
    const controls = new Map<string, ProjectTodo[]>();
    if (!transcript || !this.available) return controls;
    const placed = new Set<string>();
    for (let index = transcript.parts.length - 1; index >= 0; index--) {
      const part = transcript.parts[index]!;
      const origin = resultTodoOrigin(part, transcript.chatSessionId);
      if (!origin) continue;
      const items = this.itemsForResult(origin).filter((item) => !placed.has(item.id));
      if (!items.length) continue;
      for (const item of items) placed.add(item.id);
      controls.set(part.id, items);
    }
    return controls;
  }

  /** The to-dos whose Done control belongs on this transcript part, if any. */
  itemsForPart(partId: string): readonly ProjectTodo[] {
    return this.resultControls.get(partId) ?? [];
  }

  toggle() {
    if (this.visible) this.props.sidePanel().close();
    else this.open();
  }
  open() {
    const source = this.source;
    if (source)
      this.props.sidePanel().open({
        key: "project-todos",
        title: "To-do",
        todos: this,
      });
  }
  toggleDone() {
    this.doneExpanded = !this.doneExpanded;
  }
  select(item: ProjectTodo) {
    if (item.state !== "open") return;
    return this.mutate({
      _tag: "Select",
      selectedId: this.value?.selectedId === item.id ? null : item.id,
    });
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
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }
}
