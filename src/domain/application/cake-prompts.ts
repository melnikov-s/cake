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

export const defaultCakePrompts = (): CakePrompts => ({
  worktreeCommit: [
    "Cake is preparing to merge this worktree into {{target}}, but it has uncommitted changes.",
    "",
    "Inspect the complete working tree, verify the change, and commit all intended work with an appropriate commit message.",
    "",
    "Do not merge, rebase, push, switch branches, or modify the target checkout. Cake will merge the committed branch after this turn finishes.",
  ].join("\n"),
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
