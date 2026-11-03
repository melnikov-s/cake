import { Schema } from "effect";
import { PROJECT_ICON_FILE_MAX_BYTES, ProjectSettings } from "../application/application-data";
import { ProjectChatInstructions } from "./project-chat-instructions";

const boundedProjectPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));

export const projectIconPathGuidance = `Set the icon with iconPath: an absolute or ~/ path to a local PNG, JPEG, GIF or WebP file of at most ${PROJECT_ICON_FILE_MAX_BYTES.toLocaleString("en-US")} bytes. Cake reads and stores the image; never send image bytes. Transparency is preserved. Results report the icon as { mimeType, sizeBytes }.`;

const ProjectSettingsChanges = Schema.Struct({
  browserDefaultUrl: ProjectSettings.fields.browserDefaultUrl,
  worktreeCreateCommand: Schema.optionalKey(ProjectSettings.fields.worktreeCreateCommand),
  worktreeSetupCommands: Schema.optionalKey(ProjectSettings.fields.worktreeSetupCommands),
  worktreeSetupInstructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
  worktreeRemoveCommand: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
  worktreeCommandTimeoutSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400 })),
  ),
  worktreeLanding: Schema.optionalKey(Schema.Literals(["merge", "pull-request"])),
  customInstructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
  projectChatInstructions: Schema.optionalKey(ProjectChatInstructions.fields.instructions),
  /** Absolute or ~/ path to a PNG, JPEG, GIF or WebP file; Cake reads and stores the image itself. */
  iconPath: Schema.optionalKey(boundedProjectPath),
}).check(
  Schema.makeFilter((changes) => Object.values(changes).some((value) => value !== undefined), {
    expected: "at least one project setting",
  }),
);

export const CurrentProjectSettingsGetInput = Schema.Struct({});

export const CurrentProjectSettingsUpdateInput = Schema.Struct({
  changes: ProjectSettingsChanges,
});

export const ProjectSettingsGetInput = Schema.Struct({
  projectPath: boundedProjectPath,
});
export interface ProjectSettingsGetInput extends Schema.Schema.Type<
  typeof ProjectSettingsGetInput
> {}

export const ProjectSettingsUpdateInput = Schema.Struct({
  projectPath: boundedProjectPath,
  changes: ProjectSettingsChanges,
});
export interface ProjectSettingsUpdateInput extends Schema.Schema.Type<
  typeof ProjectSettingsUpdateInput
> {}
