import { Schema } from "effect";

const promptTemplate = Schema.String.check(Schema.isMaxLength(32_768));

/** User-editable prompts Cake sends as user turns while completing worktree operations. */
export const CakePrompts = Schema.Struct({
  worktreeCommit: promptTemplate,
  worktreeRebaseConflict: promptTemplate,
  worktreePreserveConflict: promptTemplate,
  worktreeSquashConflict: promptTemplate,
  worktreeSquashMessage: promptTemplate,
});

export interface CakePrompts extends Schema.Schema.Type<typeof CakePrompts> {}

/** Persist only custom text. Missing keys follow the current source defaults. */
export const CakePromptOverrides = Schema.Struct({
  worktreeCommit: Schema.optionalKey(promptTemplate),
  worktreeRebaseConflict: Schema.optionalKey(promptTemplate),
  worktreePreserveConflict: Schema.optionalKey(promptTemplate),
  worktreeSquashConflict: Schema.optionalKey(promptTemplate),
  worktreeSquashMessage: Schema.optionalKey(promptTemplate),
});

export interface CakePromptOverrides extends Schema.Schema.Type<typeof CakePromptOverrides> {}

export function normalizeCakePromptOverrides(overrides: CakePromptOverrides): CakePromptOverrides {
  const defaults = defaultCakePrompts();
  const result: { -readonly [Key in keyof CakePrompts]?: string } = {};
  // SAFETY: defaultCakePrompts constructs exactly the five declared CakePrompts keys.
  for (const key of Object.keys(defaults) as Array<keyof CakePrompts>) {
    const value = overrides[key];
    if (value?.trim() && value !== defaults[key]) result[key] = value;
  }
  return result;
}

export function resolveCakePrompts(overrides: CakePromptOverrides): CakePrompts {
  return { ...defaultCakePrompts(), ...normalizeCakePromptOverrides(overrides) };
}

export const defaultCakePrompts = (): CakePrompts => ({
  worktreeCommit: "Commit this change.",
  worktreeRebaseConflict: [
    "Cake tried to rebase this worktree onto {{target}}, but the deterministic rebase stopped on conflicts in these files:",
    "",
    "{{files}}",
    "",
    "Resolve each conflict, preserving the intent of both sides.",
    "Stage the resolved files and continue with `GIT_EDITOR=true git rebase --continue` until the rebase is complete.",
    "",
    "Do not push, merge, switch branches, or rewrite commit messages.",
  ].join("\n"),
  worktreePreserveConflict: [
    "Cake is landing this worktree into {{target}} by replaying its commits on top of {{target}}.",
    "The rebase stopped on conflicts in these files:",
    "",
    "{{files}}",
    "",
    "Resolve each conflict in the working tree, preserving the intent of both sides.",
    "Stage the resolved files and continue the rebase with `GIT_EDITOR=true git rebase --continue` until the rebase is complete.",
    "",
    "Do not push, merge, or switch branches, and do not rewrite commit messages. Cake will finish the landing.",
  ].join("\n"),
  worktreeSquashConflict: [
    "Cake is preparing to squash this worktree into {{target}} as one commit, but the combined change conflicts with {{target}}.",
    "Git stopped on conflicts in these files:",
    "",
    "{{files}}",
    "",
    "1. Resolve the conflicts in the working tree, preserving the intent of both sides.",
    "2. Complete the in-progress merge with `git commit --no-edit`.",
    "3. Inspect the complete change against {{target}}, then propose one commit message for it with the Cake `worktrees.proposeSquashMessage` tool (a subject and optional body).",
    "",
    "Do not push, rebase, or switch branches, and do not touch the target checkout. Cake will finish the landing.",
  ].join("\n"),
  worktreeSquashMessage: [
    "Cake is preparing to squash this worktree into {{target}} as one commit.",
    "",
    "Inspect the complete change (for example `git log --reverse {{target}}..HEAD`, `git diff --stat {{target}}...HEAD`, and file contents where needed), then propose one commit message describing the entire resulting change with the Cake `worktrees.proposeSquashMessage` tool: a concise subject line plus an optional body.",
    "",
    "Do not modify Git state; Cake will create the commit.",
  ].join("\n"),
});

export function renderCakePrompt(
  template: string,
  values: { readonly target: string; readonly files?: ReadonlyArray<string> },
): string {
  const files = values.files?.length
    ? values.files.map((file) => `- ${file}`).join("\n")
    : "- Run `git status` to list the conflicted files.";
  return template.replaceAll("{{target}}", values.target).replaceAll("{{files}}", files);
}
