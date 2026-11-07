import { Model, child, observable, transient } from "r-state-tree";
import { Project } from "./Project";

export class ProjectCatalog extends Model {
  @transient readonly runningProjectPaths: string[] = observable([]);
  @child(Project) projects: Project[] = observable([]);

  find(path: string) {
    return this.projects.find((project) => project.path === path);
  }
}
