import { Store } from "r-state-tree";
import {
  type ProjectTodo,
  type ProjectTodos,
  type ProjectTodoUserMutation,
  type TodoChat,
} from "../../contracts/projects/project-todos";
import { parseSessionLink } from "../../contracts/conversations/message-reference";
import { parseSubagentLink } from "../../contracts/subagents/subagent-reference";
import { ClientContext } from "./context/ClientContext";
import { SessionMetadataContext } from "./context/SessionMetadataContext";
import { isActiveSessionActivity } from "../lib/session-activity";
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
  readonly references?: readonly string[];
}

export class ProjectTodosStore extends Store<{
  list(): TodoListSource | undefined;
  sidePanel(): SideChatStore;
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
    return this.orderedItems.filter(
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
  get orderedItems() {
    const metadata = SessionMetadataContext.consume(this)!;
    return (this.value?.items ?? [])
      .map((item) => {
        let needsInput = false;
        let active = false;
        let unread = false;
        let modifiedAt = item.modifiedAt ?? "";
        // Required work links use the same activity authority as session dots.
        // Source links are context, not the activity of the task they reference.
        for (const link of item.associations) {
          if (link.kind !== "session") continue;
          const activity = metadata.sessionActivity(link.sessionId);
          needsInput ||= activity === "waiting" || activity === "blocked";
          active ||= isActiveSessionActivity(activity);
          unread ||= activity === "unread";
          const sessionModifiedAt = metadata.sessionModifiedAt(link.sessionId) ?? "";
          if (sessionModifiedAt > modifiedAt) modifiedAt = sessionModifiedAt;
        }
        return { item, group: needsInput ? 0 : active ? 3 : unread ? 1 : 2, modifiedAt };
      })
      .sort(
        (a, b) =>
          a.group - b.group ||
          b.modifiedAt.localeCompare(a.modifiedAt) ||
          a.item.id.localeCompare(b.item.id),
      )
      .map(({ item }) => item);
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
