import { Model, child, id, state, toSnapshot } from "r-state-tree";
import { applicationStateSchema, type ApplicationState, type ProjectRecord } from "../ipc/session-contract";

export class ProjectModel extends Model {
  @id
  path = "";
  @state
  name = "";
  @state
  addedAt = "";
  @state
  lastOpenedAt = "";
  @state
  archivedSessionIds: string[] = [];

  rename(name: string) {
    const next = name.trim();
    if (next) this.name = next.slice(0, 512);
  }

  touch(at = new Date().toISOString()) {
    this.lastOpenedAt = at;
  }

  setSessionArchived(sessionId: string, archived: boolean) {
    const current = new Set(this.archivedSessionIds);
    if (archived) current.add(sessionId);
    else current.delete(sessionId);
    this.archivedSessionIds = [...current];
  }
}

export class ApplicationModel extends Model {
  @state
  schemaVersion = 1 as const;
  @child(ProjectModel)
  projects: ProjectModel[] = [];

  static from(input: unknown) {
    return ApplicationModel.create(applicationStateSchema.parse(input));
  }

  upsertProject(path: string, defaultName: string) {
    const existing = this.projects.find((project) => project.path === path);
    if (existing) {
      existing.touch();
      return existing;
    }
    const now = new Date().toISOString();
    const project = ProjectModel.create({ path, name: defaultName, addedAt: now, lastOpenedAt: now, archivedSessionIds: [] });
    this.projects = [project, ...this.projects];
    return project;
  }

  removeProject(path: string) {
    this.projects = this.projects.filter((project) => project.path !== path);
  }

  snapshot(): ApplicationState {
    return applicationStateSchema.parse(toSnapshot(this));
  }

  project(path: string): ProjectRecord | undefined {
    const match = this.projects.find((project) => project.path === path);
    return match ? {
      path: match.path,
      name: match.name,
      addedAt: match.addedAt,
      lastOpenedAt: match.lastOpenedAt,
      archivedSessionIds: match.archivedSessionIds.slice()
    } : undefined;
  }
}
