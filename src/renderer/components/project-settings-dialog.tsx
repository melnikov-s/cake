import type { FormEvent } from "react";
import { observer } from "r-state-tree/react";
import type { ProjectSettingsStore } from "../stores/ProjectSettingsStore";
import { Button } from "./ui/button";
import {
  DialogBackdrop,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Textarea } from "./ui/textarea";

const variables = [
  ["{projectPath}", "registered project directory"],
  ["{worktreePath}", "new checkout directory"],
  ["{worktreeName}", "generated or requested worktree name"],
  ["{branchName}", "full agent/… branch name"],
  ["{baseBranch}", "branch the worktree starts from"],
  ["{baseCommit}", "commit the worktree starts from"],
] as const;

export const ProjectSettingsDialog = observer(function ProjectSettingsDialog({
  store,
}: {
  store: ProjectSettingsStore;
}) {
  if (!store.projectPath) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void store.save();
  };

  return (
    <DialogBackdrop
      onClose={() => store.close()}
      aria-labelledby="project-settings-title"
      aria-describedby="project-settings-description"
    >
      <DialogContent className="max-h-[calc(100vh-3rem)] max-w-[44rem] overflow-y-auto">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle id="project-settings-title">{store.projectName} settings</DialogTitle>
            <DialogDescription id="project-settings-description">
              Configure how Cake creates and prepares managed worktrees for this project.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-5 grid gap-5">
            <label className="grid gap-2">
              <span className="text-xs font-semibold text-foreground">
                Worktree creation command
              </span>
              <Textarea
                autoFocus
                font="mono"
                rows={3}
                maxLength={16_384}
                spellCheck={false}
                value={store.worktreeCreateCommand}
                onChange={(event) => store.setWorktreeCreateCommand(event.target.value)}
                aria-describedby="worktree-command-help"
              />
              <span
                id="worktree-command-help"
                className="text-[11px] leading-relaxed text-muted-foreground"
              >
                Runs once from the repository root. Cake shell-quotes each variable value before
                substitution. Leave variables unquoted in the command.
              </span>
            </label>

            <label className="grid gap-2">
              <span className="text-xs font-semibold text-foreground">Setup commands</span>
              <Textarea
                font="mono"
                rows={6}
                maxLength={65_536}
                spellCheck={false}
                placeholder={
                  "pnpm install\n# or: ln -s {projectPath}/node_modules {worktreePath}/node_modules"
                }
                value={store.worktreeSetupCommands}
                onChange={(event) => store.setWorktreeSetupCommands(event.target.value)}
                aria-describedby="worktree-setup-help"
              />
              <span
                id="worktree-setup-help"
                className="text-[11px] leading-relaxed text-muted-foreground"
              >
                Runs as one shell script from inside the new worktree after creation. A failed
                command stops session startup and removes the incomplete worktree.
              </span>
            </label>

            <div className="rounded-lg border border-border bg-muted/45 p-3">
              <h3 className="text-xs font-semibold text-foreground">Available variables</h3>
              <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                {variables.map(([name, description]) => (
                  <div key={name} className="contents">
                    <dt className="font-mono text-foreground">{name}</dt>
                    <dd>{description}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {store.error && (
              <p role="alert" className="text-xs text-destructive">
                {store.error}
              </p>
            )}
          </div>

          <DialogFooter className="items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() => store.resetDefaults()}
              disabled={store.saving}
            >
              Restore defaults
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => store.close()}
                disabled={store.saving}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!store.canSave}>
                {store.saving ? "Saving…" : "Save settings"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </DialogBackdrop>
  );
});
