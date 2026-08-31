import { Schema } from "effect";
import { Model, createModel, type ModelInstance } from "effect-state-tree";
import { ProjectRecord } from "../../domain/application-data";

export const Project = createModel(
  "Project",
  Schema.Struct({
    identity: Model.id(ProjectRecord.fields.path),
    record: ProjectRecord,
  }),
  (self) => ({
    get path() {
      return self.identity.value;
    },
    get name() {
      return self.record.value.name;
    },
    get addedAt() {
      return self.record.value.addedAt;
    },
    get lastOpenedAt() {
      return self.record.value.lastOpenedAt;
    },
    update(record: ProjectRecord) {
      if (record.path !== self.identity.value)
        throw new Error("A Project update cannot change its identity");
      self.record.set({ ...record });
    },
  }),
);

export type Project = ModelInstance<typeof Project>;
