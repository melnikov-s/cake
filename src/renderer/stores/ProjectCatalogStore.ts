import { Store, observable } from "r-state-tree";
import type { ApplicationState, ProjectRecord } from "../../ipc/session-contract";
import type { SessionCatalogStore } from "./SessionCatalogStore";

/** Owns Cake's renderer projection of registered projects and their window ordering. */
export class ProjectCatalogStore extends Store<{ sessions: SessionCatalogStore }> {
  readonly projects: ProjectRecord[] = observable([]);
  readonly recentProjectPaths: string[] = observable([]);

  find(path: string) {
    return this.projects.find((project) => project.path === path);
  }

  nameFromPath(path: string) {
    const normalized = path.replace(/\/+$/, "");
    return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
  }

  nameForPath(path: string) {
    return this.find(path)?.name ?? this.nameFromPath(path);
  }

  applyApplicationState(state: ApplicationState) {
    this.projects.splice(0, this.projects.length, ...state.projects);
    this.props.sessions.applyResolvedState(state.resolvedSessionIds);
    this.props.sessions.updateWorkspaceNames(
      new Map(state.projects.map((project) => [project.path, project.name])),
    );
    this.reconcileRecentPaths();
  }

  restoreRecentPaths(paths: readonly string[]) {
    this.recentProjectPaths.splice(0, this.recentProjectPaths.length, ...paths);
    this.reconcileRecentPaths();
  }

  recordOpened(path: string) {
    if (!this.recentProjectPaths.includes(path)) this.recentProjectPaths.push(path);
  }

  private reconcileRecentPaths() {
    const registeredPaths = new Set(this.projects.map((project) => project.path));
    const paths = this.recentProjectPaths.filter((path) => registeredPaths.has(path));
    for (const project of this.projects)
      if (!paths.includes(project.path)) paths.push(project.path);
    this.recentProjectPaths.splice(0, this.recentProjectPaths.length, ...paths);
  }
}
