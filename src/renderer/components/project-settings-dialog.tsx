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
import { Input } from "./ui/input";
import { LabelSettings } from "./label-settings";
import { Avatar } from "./ui/avatar";

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
              Configure personal instructions, the browser, project icon, labels, and managed
              worktrees.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-5 grid gap-5">
            <label className="grid gap-2">
              <span className="text-xs font-semibold text-foreground">Browser default URL</span>
              <Input
                aria-label="Browser default URL"
                maxLength={16_384}
                spellCheck={false}
                placeholder="localhost:3000"
                value={store.browserDefaultUrl}
                onChange={(event) => store.setBrowserDefaultUrl(event.target.value)}
                aria-describedby="project-browser-url-help"
              />
              <span
                id="project-browser-url-help"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                Opens when this project’s browser has no page yet. Leave blank to use
                https://www.google.com/. Existing pages are preserved when switching modes.
              </span>
            </label>
            <label className="grid gap-2">
              <span className="text-xs font-semibold text-foreground">
                Project Chat instructions
              </span>
              <Textarea
                dictation
                rows={6}
                maxLength={16_384}
                placeholder="How should this project’s permanent Project Chat help you?"
                aria-label="Project Chat instructions"
                value={store.projectChatInstructions}
                onChange={(event) => store.setProjectChatInstructions(event.target.value)}
                aria-describedby="project-chat-instructions-help"
              />
              <span
                id="project-chat-instructions-help"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                Only for this project’s permanent Project Chat. Never added to coding Project
                Sessions or global Cake Chat. Applies on the next Project Chat message. Saved
                personally in Cake, not in AGENTS.md or the repository.
              </span>
            </label>
            <label className="grid gap-2">
              <span className="text-xs font-semibold text-foreground">
                Project Session instructions
              </span>
              <Textarea
                dictation
                rows={6}
                maxLength={16_384}
                placeholder="How should the agent work on this project?"
                aria-label="Project Session instructions"
                value={store.customInstructions}
                onChange={(event) => store.setCustomInstructions(event.target.value)}
                aria-describedby="project-custom-instructions-help"
              />
              <span
                id="project-custom-instructions-help"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                For coding Project Sessions only, not permanent Project Chat. Existing custom
                instructions are preserved here; they have not been moved to Project Chat. Personal
                to this Cake installation; not written to AGENTS.md or the repository. Added
                alongside global Project Session instructions and repository guidance when a session
                runtime starts or restarts.
              </span>
            </label>
            <section aria-labelledby="project-icon-title" className="grid gap-2">
              <span id="project-icon-title" className="text-xs font-semibold text-foreground">
                Project icon
              </span>
              <div className="flex items-center gap-3 phone:flex-wrap rounded-lg border border-border bg-muted/25 p-3">
                <Avatar
                  kind="project"
                  seed={store.projectName}
                  customIcon={store.icon}
                  className="size-10"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-foreground">
                    {store.icon ? "Custom icon" : "Generated from the project name"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    PNG, JPEG, GIF, or WebP under 750 KB. Cake controls its displayed size.
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {store.icon && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => store.removeIcon()}
                      disabled={store.choosingIcon || store.saving}
                    >
                      Remove
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void store.chooseIcon()}
                    disabled={store.choosingIcon || store.saving}
                  >
                    {store.choosingIcon ? "Choosing…" : "Choose icon…"}
                  </Button>
                </div>
              </div>
            </section>

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
                className="text-xs leading-relaxed text-muted-foreground"
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
                className="text-xs leading-relaxed text-muted-foreground"
              >
                Runs as one shell script from inside the new worktree after creation. A failed
                command stops session startup and removes the incomplete worktree.
              </span>
            </label>

            <label className="grid gap-2">
              <span className="text-xs font-semibold text-foreground">Setup instructions</span>
              <Textarea
                dictation
                rows={5}
                maxLength={16_384}
                placeholder="Dependencies are not installed in fresh worktrees. Run pnpm install only if you need them."
                value={store.worktreeSetupInstructions}
                onChange={(event) => store.setWorktreeSetupInstructions(event.target.value)}
                aria-describedby="worktree-setup-instructions-help"
              />
              <span
                id="worktree-setup-instructions-help"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                Added to the agent prompt for sessions running in a Cake-managed worktree. Use this
                for conditional guidance; put commands that must always run in Setup commands.
              </span>
            </label>

            <div className="rounded-lg border border-border bg-muted/45 p-3">
              <h3 className="text-xs font-semibold text-foreground">Available variables</h3>
              <dl className="mt-2 grid grid-cols-[max-content_1fr] phone:grid-cols-1 phone:break-words gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {variables.map(([name, description]) => (
                  <div key={name} className="contents">
                    <dt className="font-mono text-foreground">{name}</dt>
                    <dd>{description}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <LabelSettings
              store={store}
              title="Project-specific labels"
              description="Add labels only this project needs. Global labels remain available here too. Changes save immediately."
              placeholder="New project label"
            />

            {store.error && (
              <p role="alert" className="text-xs text-destructive">
                {store.error}
              </p>
            )}
          </div>

          <DialogFooter className="items-center justify-between phone:flex-wrap phone:gap-3">
            <Button
              type="button"
              variant="ghost"
              onClick={() => store.resetDefaults()}
              disabled={store.saving}
            >
              Restore worktree defaults
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
