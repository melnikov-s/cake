export interface WorktreeCommandVariables {
  readonly projectPath: string;
  readonly worktreePath: string;
  readonly worktreeName: string;
  readonly branchName: string;
  readonly baseBranch: string;
  readonly baseCommit: string;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Substitutes the documented placeholders as shell-safe scalar arguments. */
export function renderWorktreeCommand(
  template: string,
  variables: WorktreeCommandVariables,
): string {
  return template.replaceAll(
    /\{(projectPath|worktreePath|worktreeName|branchName|baseBranch|baseCommit)\}/g,
    (placeholder, name) => {
      switch (name) {
        case "projectPath":
          return shellQuote(variables.projectPath);
        case "worktreePath":
          return shellQuote(variables.worktreePath);
        case "worktreeName":
          return shellQuote(variables.worktreeName);
        case "branchName":
          return shellQuote(variables.branchName);
        case "baseBranch":
          return shellQuote(variables.baseBranch);
        case "baseCommit":
          return shellQuote(variables.baseCommit);
        default:
          return placeholder;
      }
    },
  );
}
