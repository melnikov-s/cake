import { Model, child, observable } from "r-state-tree";
import { Project } from "./Project";

export class ProjectCatalog extends Model {
  @child(Project) projects: Project[] = observable([]);

  find(path: string) {
    return this.projects.find((project) => project.path === path);
  }
}
