import { Store } from "r-state-tree";
import type { Project } from "../models/Project";
import type { ProjectTodo, ProjectTodoUserMutation } from "../../contracts/projects/project-todos";
import { ClientContext } from "./context/ClientContext";
import type { SideChatStore } from "./SideChatStore";
import { describeError } from "../lib/error-details";

export class ProjectTodosStore extends Store<{
  project(): Project | undefined;
  sidePanel(): SideChatStore;
}> {
  doneExpanded = false;
  busy = false;
  error: string | undefined;

  get project() {
    return this.props.project();
  }
  get value() {
    return this.project?.todos;
  }
  get openItems() {
    return this.value?.items.filter((item) => item.state === "open") ?? [];
  }
  get doneItems() {
    return this.value?.items.filter((item) => item.state === "done") ?? [];
  }
  get visible() {
    return this.props.sidePanel().target?.key === "project-todos";
  }

  toggle() {
    if (this.visible) this.props.sidePanel().close();
    else if (this.project)
      this.props.sidePanel().open({
        key: "project-todos",
        title: "To-do",
        eyebrow: () => "Project Chat",
        todos: this,
      });
  }
  toggleDone() {
    this.doneExpanded = !this.doneExpanded;
  }
  select(item: ProjectTodo) {
    return this.mutate({
      _tag: "Select",
      selectedId: this.value?.selectedId === item.id ? null : item.id,
    });
  }
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
    const projectPath = this.project?.path;
    if (!projectPath || this.busy || this.signal.aborted) return;
    this.busy = true;
    this.error = undefined;
    try {
      await ClientContext.consume(this)!.projectTodos.mutateUser(
        { projectPath, mutation },
        { signal: this.signal },
      );
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }
}
