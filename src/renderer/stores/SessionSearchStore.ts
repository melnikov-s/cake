import { Store, computed } from "r-state-tree";
import { createSessionSearchIndex, searchSessions } from "../lib/session-search";
import type { SessionCatalogStore } from "./SessionCatalogStore";

/** Sidebar-owned, ephemeral session picker. Searches the shared catalog rather
 * than visible rows, so collapsed families remain findable. */
export class SessionSearchStore extends Store<{
  catalog: SessionCatalogStore;
}> {
  mode: "closed" | "preview" | "active" = "closed";
  includeResolved = false;

  get open() {
    return this.mode !== "closed";
  }

  @computed
  get search() {
    const sessions = this.props.catalog.sessions;
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

  show(mode: "preview" | "active" = "active") {
    this.includeResolved = false;
    this.mode = mode;
  }

  activatePreview() {
    if (this.mode === "preview") this.mode = "active";
  }

  dismissPreview() {
    if (this.mode === "preview") this.close();
  }

  close() {
    this.mode = "closed";
  }

  setIncludeResolved(includeResolved: boolean) {
    this.includeResolved = includeResolved;
  }

  select(id: string) {
    const session = this.props.catalog.find(id);
    if (this.mode !== "active" || !session || (!this.includeResolved && session.resolved))
      return false;
    this.close();
    return true;
  }
}
