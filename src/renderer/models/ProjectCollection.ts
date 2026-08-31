import { Schema } from "effect";
import { Model, createModel, type ModelInstance } from "effect-state-tree";
import { Project } from "./Project";

export const ProjectCollection = createModel(
  "ProjectCollection",
  Schema.Struct({
    projects: Schema.Array(Model.child(Project.schema)),
  }),
  (self) => ({
    replace(projects: ReadonlyArray<Project>) {
      const retained = new Set(projects.map((project) => project.identity.value));
      const removed = self.projects.value.filter(
        (project) => !retained.has(project.identity.value),
      );
      self.projects.set([...projects]);
      for (const project of removed) project[Symbol.dispose]();
    },
  }),
);

export type ProjectCollection = ModelInstance<typeof ProjectCollection>;
