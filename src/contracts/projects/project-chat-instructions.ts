import { Schema } from "effect";

// Mutation inputs must require explicit text, unlike persisted settings’ decoding defaults.
const InstructionText = Schema.String.check(Schema.isMaxLength(16_384));

export const ProjectChatInstructionsGet = Schema.Struct({
  projectPath: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
});
export interface ProjectChatInstructionsGet extends Schema.Schema.Type<
  typeof ProjectChatInstructionsGet
> {}

export const ProjectChatInstructions = Schema.Struct({
  projectPath: ProjectChatInstructionsGet.fields.projectPath,
  instructions: InstructionText,
});
export interface ProjectChatInstructions extends Schema.Schema.Type<
  typeof ProjectChatInstructions
> {}

export const ProjectChatInstructionsUpdate = Schema.Struct({
  ...ProjectChatInstructions.fields,
  expectedInstructions: InstructionText,
});
export interface ProjectChatInstructionsUpdate extends Schema.Schema.Type<
  typeof ProjectChatInstructionsUpdate
> {}

/** Registered-project settings authority; not shared Cake Chat preferences. */
export interface ProjectChatInstructionsControl {
  get(input: ProjectChatInstructionsGet, signal: AbortSignal): Promise<ProjectChatInstructions>;
  update(
    input: ProjectChatInstructionsUpdate,
    signal: AbortSignal,
  ): Promise<ProjectChatInstructions>;
}
