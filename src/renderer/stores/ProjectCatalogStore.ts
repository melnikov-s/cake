import { Store, observable, snapshot } from "r-state-tree";
import type { ProjectCatalog } from "../models/ProjectCatalog";
import type { SessionCatalogStore } from "./SessionCatalogStore";

/** Owns renderer-local recent Project ordering over the authoritative Project projection. */
export class ProjectCatalogStore extends Store<{
  sessions: SessionCatalogStore;
  model: ProjectCatalog;
}> {
  @snapshot readonly recentProjectPaths: string[] = observable([]);

  get projects() {
    return this.props.model.projects;
  }

  find(path: string) {
    return this.props.model.find(path);
  }

  nameFromPath(path: string) {
    const normalized = path.replace(/\/+$/, "");
    return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
  }

  nameForPath(path: string) {
    const managedProject = this.props.sessions.projectOfManagedWorktree(path);
    return this.nameForRegisteredPath(managedProject ?? path);
  }

  private nameForRegisteredPath(path: string) {
    return this.find(path)?.name ?? this.nameFromPath(path);
  }

  get orderedProjectPaths() {
    const persistedOrder = new Map(this.recentProjectPaths.map((path, index) => [path, index]));
    const lastSessionByProject = new Map<string, string>();
    for (const session of this.props.sessions.sessions) {
      const previous = lastSessionByProject.get(session.projectPath);
      if (!previous || session.modifiedAt > previous)
        lastSessionByProject.set(session.projectPath, session.modifiedAt);
    }

    const registeredPaths = new Set(this.projects.map((project) => project.path));
    const paths = this.recentProjectPaths.filter((path) => registeredPaths.has(path));
    for (const project of this.projects)
      if (!paths.includes(project.path)) paths.push(project.path);
    return paths.sort((left, right) => {
      const leftLastSession = lastSessionByProject.get(left);
      const rightLastSession = lastSessionByProject.get(right);
      if (leftLastSession && rightLastSession && leftLastSession !== rightLastSession)
        return rightLastSession.localeCompare(leftLastSession);
      if (leftLastSession) return -1;
      if (rightLastSession) return 1;
      const leftLastOpened = this.find(left)?.lastOpenedAt ?? "";
      const rightLastOpened = this.find(right)?.lastOpenedAt ?? "";
      if (leftLastOpened !== rightLastOpened) return rightLastOpened.localeCompare(leftLastOpened);
      return (persistedOrder.get(left) ?? 0) - (persistedOrder.get(right) ?? 0);
    });
  }

  recordOpened(path: string) {
    if (!this.recentProjectPaths.includes(path)) this.recentProjectPaths.push(path);
  }
}
