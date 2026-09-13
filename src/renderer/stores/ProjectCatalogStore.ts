import { Store, observable, snapshot } from "r-state-tree";
import type { ProjectCatalog } from "../models/ProjectCatalog";
import type { SessionCatalogStore } from "./SessionCatalogStore";

/** Owns the user's stable, window-persisted Project order. */
export class ProjectCatalogStore extends Store<{
  model: ProjectCatalog;
  sessions: SessionCatalogStore;
}> {
  @snapshot readonly projectOrder: string[] = observable([]);

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
    const registeredPaths = new Set(this.projects.map((project) => project.path));
    const paths = this.projectOrder.filter((path) => registeredPaths.has(path));
    for (const project of this.projects)
      if (!paths.includes(project.path)) paths.push(project.path);
    return paths;
  }

  register(path: string) {
    if (!this.projectOrder.includes(path)) this.projectOrder.push(path);
  }

  move(sourcePath: string, targetPath: string, placement: "before" | "after") {
    if (sourcePath === targetPath) return;
    const paths = this.orderedProjectPaths;
    const sourceIndex = paths.indexOf(sourcePath);
    const targetIndex = paths.indexOf(targetPath);
    if (sourceIndex < 0 || targetIndex < 0) return;
    paths.splice(sourceIndex, 1);
    const adjustedTarget = paths.indexOf(targetPath);
    paths.splice(adjustedTarget + (placement === "after" ? 1 : 0), 0, sourcePath);
    this.projectOrder.splice(0, this.projectOrder.length, ...paths);
  }
}
