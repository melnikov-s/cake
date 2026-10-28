/** Facts substituted into a project's configured worktree lifecycle commands. */
export interface WorktreeCommandVariables {
  /** The registered project directory. */
  readonly projectPath: string;
  /** The project directory inside the worktree checkout: where sessions and setup run. */
  readonly worktreePath: string;
  /** The worktree checkout root. */
  readonly checkoutPath: string;
  readonly worktreeName: string;
  readonly branchName: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
  /** Why a remove command runs: `discard`, `resolve` or `rollback`; empty for other commands. */
  readonly removeReason: string;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const names = new Set<string>([
  "projectPath",
  "worktreePath",
  "checkoutPath",
  "worktreeName",
  "branchName",
  "baseBranch",
  "baseCommit",
  "removeReason",
] satisfies ReadonlyArray<keyof WorktreeCommandVariables>);

const isVariableName = (name: string): name is keyof WorktreeCommandVariables => names.has(name);

/** Substitutes the documented placeholders as shell-safe scalar arguments. */
export function renderWorktreeCommand(
  template: string,
  variables: WorktreeCommandVariables,
): string {
  return template.replaceAll(/\{([A-Za-z]+)\}/g, (placeholder, name: string) =>
    isVariableName(name) ? shellQuote(variables[name]) : placeholder,
  );
}
