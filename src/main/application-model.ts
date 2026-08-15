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
    const index = this.archivedSessionIds.indexOf(sessionId);
    if (archived && index === -1) this.archivedSessionIds.push(sessionId);
    else if (!archived && index !== -1) this.archivedSessionIds.splice(index, 1);
  }
}

export class ApplicationModel extends Model {
  @state
  schemaVersion = 1 as const;
  @child(ProjectModel)
  projects: ProjectModel[] = [];
  @state
  trustedProjectPaths: string[] = [];

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
    this.projects.unshift(project);
    return project;
  }

  removeProject(path: string) {
    const index = this.projects.findIndex((project) => project.path === path);
    if (index !== -1) this.projects.splice(index, 1);
    this.revokeProjectTrust(path);
  }

  trustProject(path: string) {
    if (this.trustedProjectPaths.includes(path)) return;
    if (this.trustedProjectPaths.length >= 200) throw new Error("Project trust registry is full");
    this.trustedProjectPaths.push(path);
  }

  revokeProjectTrust(path: string) {
    const index = this.trustedProjectPaths.indexOf(path);
    if (index !== -1) this.trustedProjectPaths.splice(index, 1);
  }

  isProjectTrusted(path: string) {
    return this.trustedProjectPaths.includes(path);
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
