import { Schema } from "effect";

const promptTemplate = Schema.String.check(Schema.isMaxLength(32_768));

/** Serialized prompt settings, including the complete version-five representation. */
export const CakePrompts = Schema.Struct({
  worktreeCommit: promptTemplate,
  worktreeRebaseConflict: promptTemplate,
  worktreePreserveConflict: promptTemplate,
  worktreeSquashConflict: promptTemplate,
  worktreeSquashMessage: promptTemplate,
  dictationCleanup: promptTemplate,
});
export interface CakePrompts extends Schema.Schema.Type<typeof CakePrompts> {}

/** Current storage persists only custom text; domain policy supplies source defaults. */
export const CakePromptOverrides = Schema.Struct({
  worktreeCommit: Schema.optionalKey(promptTemplate),
  worktreeRebaseConflict: Schema.optionalKey(promptTemplate),
  worktreePreserveConflict: Schema.optionalKey(promptTemplate),
  worktreeSquashConflict: Schema.optionalKey(promptTemplate),
  worktreeSquashMessage: Schema.optionalKey(promptTemplate),
  dictationCleanup: Schema.optionalKey(promptTemplate),
});
export interface CakePromptOverrides extends Schema.Schema.Type<typeof CakePromptOverrides> {}
