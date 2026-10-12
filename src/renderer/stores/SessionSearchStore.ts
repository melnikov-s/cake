import { Store, computed } from "r-state-tree";
import { createSessionSearchIndex, searchSessions } from "../lib/session-search";
import type { SessionCatalogStore } from "./SessionCatalogStore";

/** Sidebar-owned, ephemeral session picker. Searches the shared catalog rather
 * than visible rows, so collapsed families remain findable. */
export class SessionSearchStore extends Store<{
  catalog: SessionCatalogStore;
  focusedProjectPath(): string | undefined;
}> {
  open = false;
  includeResolved = false;

  @computed
  get search() {
    const path = this.props.focusedProjectPath();
    const sessions = path ? this.props.catalog.projectSessions(path) : this.props.catalog.sessions;
    const index = createSessionSearchIndex(
      this.includeResolved ? sessions : sessions.filter((session) => !session.resolved),
    );
    return (query: string) =>
      searchSessions(index, query).map((session) => ({
        id: session.sessionId,
        label: session.title || "Untitled session",
        session,
      }));
  }

  show() {
    this.includeResolved = false;
    this.open = true;
  }

  close() {
    this.open = false;
  }

  setIncludeResolved(includeResolved: boolean) {
    this.includeResolved = includeResolved;
  }

  select(id: string) {
    const session = this.props.catalog.find(id);
    const path = this.props.focusedProjectPath();
    if (
      !this.open ||
      !session ||
      (!this.includeResolved && session.resolved) ||
      (path !== undefined && session.projectPath !== path)
    )
      return false;
    this.close();
    return true;
  }
}
