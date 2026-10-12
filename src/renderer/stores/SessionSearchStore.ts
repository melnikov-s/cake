import { Store, computed } from "r-state-tree";
import { searchSessions } from "../lib/session-search";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import { ProjectCatalogContext } from "./context/ProjectCatalogContext";

/** Sidebar-owned, ephemeral session picker. Searches the shared catalog rather
 * than visible rows, so collapsed families and resolved sessions remain findable. */
export class SessionSearchStore extends Store<{
  catalog: SessionCatalogStore;
  focusedProjectPath(): string | undefined;
}> {
  open = false;
  query = "";

  get description() {
    const path = this.props.focusedProjectPath();
    return path
      ? `Search sessions in ${ProjectCatalogContext.consume(this)!.nameForPath(path)} by title.`
      : "Search sessions across all projects by title.";
  }

  @computed
  get choices() {
    const path = this.props.focusedProjectPath();
    const sessions = path ? this.props.catalog.projectSessions(path) : this.props.catalog.sessions;
    return searchSessions(sessions, this.query).map((session) => ({
      id: session.sessionId,
      label: session.title || "Untitled session",
      session,
    }));
  }

  show() {
    this.query = "";
    this.open = true;
  }

  close() {
    this.open = false;
  }

  setQuery(query: string) {
    this.query = query;
  }

  select(id: string) {
    if (!this.open || !this.choices.some((choice) => choice.id === id)) return false;
    this.close();
    return true;
  }
}
