import { Model, child, state, toSnapshot } from "r-state-tree";
import { Project } from "./Project";
import {
  applicationStateSchema,
  utilityModelSchema,
  type ApplicationState,
  type ProjectRecord,
  type UtilityModel,
} from "../ipc/session-contract";

export class Application extends Model {
  @state
  schemaVersion = 1 as const;
  @child(Project)
  projects: Project[] = [];
  @state
  resolvedSessionIds: string[] = [];
  @state
  resolvedCakeChatSessionIds: string[] = [];
  @state
  trustedProjectPaths: string[] = [];
  @state
  fastModeSessionIds: string[] = [];
  @state
  utilityModel: UtilityModel | undefined;

  static from(untrustedInput: unknown) {
    return Application.create(applicationStateSchema.parse(untrustedInput));
  }

  upsertProject(path: string, defaultName: string) {
    const existing = this.projects.find((project) => project.path === path);
    if (existing) {
      existing.touch();
      return existing;
    }
    const now = new Date().toISOString();
    const project = Project.create({
      path,
      name: defaultName,
      addedAt: now,
      lastOpenedAt: now,
    });
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

  setUtilityModel(model: UtilityModel | undefined) {
    this.utilityModel = model ? utilityModelSchema.parse(model) : undefined;
  }

  setSessionFastMode(sessionId: string, enabled: boolean) {
    const next = new Set(this.fastModeSessionIds);
    if (enabled) next.add(sessionId);
    else next.delete(sessionId);
    this.fastModeSessionIds = [...next];
  }

  hasSessionFastMode(sessionId: string) {
    return this.fastModeSessionIds.includes(sessionId);
  }

  setCakeChatSessionResolved(sessionId: string, resolved: boolean) {
    const index = this.resolvedCakeChatSessionIds.indexOf(sessionId);
    if (resolved && index === -1)
      this.resolvedCakeChatSessionIds = [...this.resolvedCakeChatSessionIds, sessionId];
    else if (!resolved && index !== -1)
      this.resolvedCakeChatSessionIds = this.resolvedCakeChatSessionIds.filter(
        (id) => id !== sessionId,
      );
  }

  setSessionsResolved(sessionIds: readonly string[], resolved: boolean) {
    const next = new Set(this.resolvedSessionIds);
    for (const sessionId of sessionIds) {
      if (resolved) next.add(sessionId);
      else next.delete(sessionId);
    }
    this.resolvedSessionIds = [...next];
  }

  isProjectTrusted(path: string) {
    return this.trustedProjectPaths.includes(path);
  }

  snapshot(): ApplicationState {
    return applicationStateSchema.parse(toSnapshot(this));
  }

  project(path: string): ProjectRecord | undefined {
    const match = this.projects.find((project) => project.path === path);
    return match
      ? {
          path: match.path,
          name: match.name,
          addedAt: match.addedAt,
          lastOpenedAt: match.lastOpenedAt,
        }
      : undefined;
  }
}
