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
import { SegmentedControlButton, SegmentedControlGroup } from "./ui/segmented-control";

const variables = [
  ["{projectPath}", "registered project directory"],
  ["{worktreePath}", "project directory inside the worktree"],
  ["{checkoutPath}", "worktree checkout root"],
  ["{worktreeName}", "generated or requested worktree name"],
  ["{branchName}", "full agent/… branch name"],
  ["{baseBranch}", "branch the worktree starts from"],
  ["{baseCommit}", "commit the worktree starts from"],
  ["{removeReason}", "discard, resolve or rollback (removal command only)"],
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
      <DialogContent className="flex max-h-[min(86vh,52rem)] max-w-[44rem] flex-col overflow-hidden p-0 phone:p-0">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <DialogHeader className="shrink-0 border-b border-border/65 bg-sidebar/30 px-5 py-3.5">
            <DialogTitle id="project-settings-title">{store.projectName} settings</DialogTitle>
            <DialogDescription id="project-settings-description">
              Configure personal instructions, the browser, project icon, labels, and managed
              worktrees.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
            <section aria-labelledby="project-general-title" className="grid gap-1.5">
              <h3
                id="project-general-title"
                className="px-0.5 text-xs font-semibold text-foreground"
              >
                General
              </h3>
              <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/80 bg-card/50">
                <div
                  aria-labelledby="project-icon-title"
                  className="flex items-center gap-3 px-3.5 py-3 phone:flex-wrap"
                >
                  <Avatar
                    kind="project"
                    seed={store.projectName}
                    customIcon={store.icon}
                    className="size-10 shrink-0"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p id="project-icon-title" className="text-xs font-medium text-foreground">
                      {store.icon ? "Custom icon" : "Generated from the project name"}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      PNG, JPEG, GIF, or WebP under 750 KB.
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

                <label className="grid gap-1.5 px-3.5 py-3">
                  <span className="text-xs font-medium text-foreground">Browser default URL</span>
                  <Input
                    autoFocus
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
                    Opens when this project’s browser has no page yet. Defaults to
                    https://www.google.com/.
                  </span>
                </label>
              </div>
            </section>

            <section aria-labelledby="project-instructions-title" className="grid gap-1.5">
              <h3
                id="project-instructions-title"
                className="px-0.5 text-xs font-semibold text-foreground"
              >
                Instructions
              </h3>
              <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/80 bg-card/50">
                <label className="grid gap-1.5 px-3.5 py-3">
                  <span className="text-xs font-medium text-foreground">
                    Project Chat instructions
                  </span>
                  <Textarea
                    dictation
                    rows={4}
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
                    Sessions or global Cake Chat.
                  </span>
                </label>

                <label className="grid gap-1.5 px-3.5 py-3">
                  <span className="text-xs font-medium text-foreground">
                    Project Session instructions
                  </span>
                  <Textarea
                    dictation
                    rows={4}
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
                    For coding Project Sessions only, not permanent Project Chat. Personal to this
                    Cake installation.
                  </span>
                </label>
              </div>
            </section>

            <section aria-labelledby="project-worktrees-title" className="grid gap-1.5">
              <h3
                id="project-worktrees-title"
                className="px-0.5 text-xs font-semibold text-foreground"
              >
                Managed worktrees
              </h3>
              <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/80 bg-card/50">
                <div className="grid gap-1.5 px-3.5 py-3">
                  <div className="flex items-center justify-between gap-3 phone:flex-wrap">
                    <span
                      id="worktree-landing-label"
                      className="text-xs font-medium text-foreground"
                    >
                      Landing
                    </span>
                    <SegmentedControlGroup
                      className="w-fit"
                      aria-labelledby="worktree-landing-label"
                      aria-describedby="worktree-landing-help"
                    >
                      <SegmentedControlButton
                        active={store.worktreeLanding === "merge"}
                        onClick={() => store.setWorktreeLanding("merge")}
                      >
                        Cake merges
                      </SegmentedControlButton>
                      <SegmentedControlButton
                        active={store.worktreeLanding === "pull-request"}
                        onClick={() => store.setWorktreeLanding("pull-request")}
                      >
                        Pull requests
                      </SegmentedControlButton>
                    </SegmentedControlGroup>
                  </div>
                  <span
                    id="worktree-landing-help"
                    className="text-xs leading-relaxed text-muted-foreground"
                  >
                    With pull requests, Cake never merges worktrees. Resolving a session removes its
                    clean worktree and keeps any branch with commits.
                  </span>
                </div>

                <label className="grid gap-1.5 px-3.5 py-3">
                  <span className="text-xs font-medium text-foreground">
                    Worktree creation command
                  </span>
                  <Textarea
                    font="mono"
                    rows={2}
                    maxLength={16_384}
                    spellCheck={false}
                    aria-label="Worktree creation command"
                    placeholder="git worktree add {checkoutPath} {branchName}"
                    value={store.worktreeCreateCommand}
                    onChange={(event) => store.setWorktreeCreateCommand(event.target.value)}
                    aria-describedby="worktree-command-help"
                  />
                  <span
                    id="worktree-command-help"
                    className="text-xs leading-relaxed text-muted-foreground"
                  >
                    Checks out {"{branchName}"} (created at {"{baseCommit}"}) in a new worktree.
                    Blank runs the placeholder command.
                  </span>
                </label>

                <label className="grid gap-1.5 px-3.5 py-3">
                  <span className="text-xs font-medium text-foreground">Setup commands</span>
                  <Textarea
                    font="mono"
                    rows={4}
                    maxLength={65_536}
                    spellCheck={false}
                    placeholder={
                      "pnpm install\n# or: ln -s {projectPath}/node_modules {worktreePath}/node_modules"
                    }
                    aria-label="Setup commands"
                    value={store.worktreeSetupCommands}
                    onChange={(event) => store.setWorktreeSetupCommands(event.target.value)}
                    aria-describedby="worktree-setup-help"
                  />
                  <span
                    id="worktree-setup-help"
                    className="text-xs leading-relaxed text-muted-foreground"
                  >
                    Runs once in {"{worktreePath}"} after creation, before the session starts.
                  </span>
                </label>

                <label className="grid gap-1.5 px-3.5 py-3">
                  <span className="text-xs font-medium text-foreground">
                    Worktree removal command
                  </span>
                  <Textarea
                    font="mono"
                    rows={2}
                    maxLength={16_384}
                    spellCheck={false}
                    aria-label="Worktree removal command"
                    placeholder="git worktree remove {checkoutPath}"
                    value={store.worktreeRemoveCommand}
                    onChange={(event) => store.setWorktreeRemoveCommand(event.target.value)}
                    aria-describedby="worktree-remove-help"
                  />
                  <span
                    id="worktree-remove-help"
                    className="text-xs leading-relaxed text-muted-foreground"
                  >
                    Removes a discarded, resolved, or failed worktree at {"{checkoutPath}"}. Blank
                    runs the placeholder command.
                  </span>
                </label>

                <label className="flex items-center justify-between gap-4 px-3.5 py-3 phone:flex-wrap">
                  <div className="grid gap-0.5">
                    <span className="text-xs font-medium text-foreground">
                      Worktree command timeout
                    </span>
                    <span id="worktree-timeout-help" className="text-xs text-muted-foreground">
                      Seconds before a creation, setup, or removal command is stopped.
                    </span>
                  </div>
                  <Input
                    aria-label="Worktree command timeout in seconds"
                    className="w-28 shrink-0 font-mono tabular-nums"
                    inputMode="numeric"
                    placeholder="No limit"
                    value={store.worktreeCommandTimeout}
                    onChange={(event) => store.setWorktreeCommandTimeout(event.target.value)}
                    aria-invalid={store.worktreeCommandTimeoutSeconds === undefined}
                    aria-describedby="worktree-timeout-help"
                  />
                </label>

                <label className="grid gap-1.5 px-3.5 py-3">
                  <span className="text-xs font-medium text-foreground">Setup instructions</span>
                  <Textarea
                    dictation
                    rows={3}
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
                    Added to the agent prompt for sessions running in a Cake-managed worktree.
                  </span>
                </label>

                <div className="bg-muted/25 px-3.5 py-3">
                  <h4 className="text-xs font-medium text-foreground">Available variables</h4>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Commands run with /bin/sh in {"{projectPath}"}. Values are shell-quoted
                    automatically; leave variables unquoted.
                  </p>
                  <dl className="mt-2.5 grid grid-cols-[max-content_1fr] items-baseline gap-x-3 gap-y-1.5 text-xs text-muted-foreground phone:grid-cols-1 phone:break-words">
                    {variables.map(([name, description]) => (
                      <div key={name} className="contents">
                        <dt>
                          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                            {name}
                          </code>
                        </dt>
                        <dd>{description}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
            </section>

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

          <DialogFooter className="mt-0 shrink-0 items-center justify-between border-t border-border/65 bg-sidebar/30 px-5 py-3 phone:flex-wrap phone:gap-3">
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
