import { Schema } from "effect";

/** Proposed contract; not wired until the backend workflow review is approved. */
export const ProjectSessionFamilyInfo = Schema.Struct({
  familyId: Schema.String,
  parentSessionId: Schema.String,
  role: Schema.Literals(["root", "child"]),
  childSessionIds: Schema.Array(Schema.String),
});
export interface ProjectSessionFamilyInfo extends Schema.Schema.Type<
  typeof ProjectSessionFamilyInfo
> {}

/** A fresh policy query, not cached runtime configuration or an admission permit. */
export const ProjectSessionAgentPolicy = Schema.Struct({
  family: Schema.optionalKey(ProjectSessionFamilyInfo),
  canFork: Schema.Boolean,
  deferResolution: Schema.Boolean,
});
export interface ProjectSessionAgentPolicy extends Schema.Schema.Type<
  typeof ProjectSessionAgentPolicy
> {}
