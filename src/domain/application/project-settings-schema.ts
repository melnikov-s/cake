import { Schema } from "effect";
import { ProjectSettings } from "./application-data";

const boundedProjectPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));

export const ProjectSettingsChanges = Schema.Struct({
  worktreeCreateCommand: Schema.optionalKey(ProjectSettings.fields.worktreeCreateCommand),
  worktreeSetupCommands: Schema.optionalKey(ProjectSettings.fields.worktreeSetupCommands),
  worktreeSetupInstructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
  icon: Schema.optionalKey(ProjectSettings.fields.icon),
}).check(
  Schema.makeFilter((changes) => Object.values(changes).some((value) => value !== undefined), {
    expected: "at least one project setting",
  }),
);

export type ProjectSettingsChanges = typeof ProjectSettingsChanges.Type;

export const CurrentProjectSettingsGetInput = Schema.Struct({});

export const CurrentProjectSettingsUpdateInput = Schema.Struct({
  changes: ProjectSettingsChanges,
});

export const ProjectSettingsGetInput = Schema.Struct({
  projectPath: boundedProjectPath,
});

export const ProjectSettingsUpdateInput = Schema.Struct({
  projectPath: boundedProjectPath,
  changes: ProjectSettingsChanges,
});
