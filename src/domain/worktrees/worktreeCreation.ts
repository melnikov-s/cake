import { Effect, FileSystem, Path } from "effect";
import type { ProjectSettings } from "../../contracts/application/application-data";
import type { WorktreeRecord } from "../../contracts/worktrees/managed-worktree-data";
import { ManagedWorktreeError } from "../../contracts/worktrees/managed-worktrees-errors";
import { Git } from "../../services/git/Git";
import {
  ManagedWorktrees,
  type WorktreeCheckoutPlan,
} from "../../services/worktrees/ManagedWorktrees";
import { renderWorktreeCommand } from "./worktree-command-template";

const normalize = (path: string) => path.replace(/\/+$/, "");
const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "") || "worktree";
const invalid = (message: string) => Effect.fail(new Error(message));

/** Cake creation policy. The engine invokes planning under its repository lock,
 * then owns checkout execution, persistence/rollback and deferred setup lifetime. */
export const createCheckout = Effect.fn("WorktreeCreation.createCheckout")(function* (
  projectPath: string,
  baseWorktreePath?: string,
  worktreeName?: string,
  settings?: ProjectSettings,
  backgroundSetup = false,
) {
  const worktrees = yield* ManagedWorktrees;
  const prepare = Effect.fn("WorktreeCreation.prepare")(
    function* (
      root: string,
      registeredProjectPath: string,
      records: ReadonlyArray<WorktreeRecord>,
    ) {
      const git = yield* Git;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const optionalGit = Effect.fn("WorktreeCreation.optionalGit")(
        (cwd: string, args: ReadonlyArray<string>) =>
          git.run(cwd, args).pipe(
            Effect.map((value) => value.trim()),
            Effect.option,
          ),
      );
      const defaultBranch = Effect.fn("WorktreeCreation.defaultBranch")(function* (root: string) {
        const remote = yield* optionalGit(root, [
          "symbolic-ref",
          "-q",
          "--short",
          "refs/remotes/origin/HEAD",
        ]);
        if (remote._tag === "Some") return remote.value.replace(/^origin\//, "") || "main";
        const current = yield* optionalGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
        return current._tag === "Some" && current.value !== "HEAD" ? current.value : "main";
      });
      const normalizedBase = baseWorktreePath && normalize(baseWorktreePath);
      const parent = normalizedBase
        ? records.find(
            (entry) =>
              ["active", "landed"].includes(entry.state ?? "active") &&
              normalize(entry.worktreePath) === normalizedBase,
          )
        : undefined;
      const projectBase =
        normalizedBase === registeredProjectPath || normalizedBase === normalize(root);
      if (
        normalizedBase &&
        ((!parent && !projectBase) || (parent && parent.projectPath !== registeredProjectPath))
      )
        return yield* invalid("Cake could not find that base worktree");
      const sourcePath = parent?.worktreePath ?? (projectBase ? normalizedBase : root);
      if (!sourcePath || !(yield* fs.exists(sourcePath)))
        return yield* invalid("The base worktree no longer exists");
      const baseBranch = parent
        ? parent.branch
        : projectBase
          ? (yield* git.run(sourcePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()
          : yield* defaultBranch(root);
      if (baseBranch === "HEAD")
        return yield* invalid("Check out a branch before creating a child worktree.");
      const baseCommit = (yield* git.run(sourcePath, [
        "rev-parse",
        normalizedBase ? "HEAD" : baseBranch,
      ])).trim();
      const slug = slugify(path.basename(root));
      const requestedName = worktreeName ?? slug;
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(requestedName))
        return yield* invalid("Invalid worktree name");
      const directory = path.join(path.dirname(root), `.${slug}-worktrees`);
      const prefix = requestedName.slice(0, 56).replace(/-+$/g, "") || "worktree";
      let name: string | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = `${prefix}-${crypto.randomUUID().slice(0, 6)}`;
        if (
          (yield* Effect.result(
            git.run(root, ["rev-parse", "--verify", "-q", `refs/heads/agent/${candidate}`]),
          ))._tag !== "Success" &&
          !(yield* fs.exists(path.join(directory, candidate)))
        ) {
          name = candidate;
          break;
        }
      }
      if (!name) return yield* invalid("Cake could not generate a unique worktree name");
      const branch = `agent/${name}`;
      const worktreePath = path.join(directory, name);
      const variables = {
        projectPath: registeredProjectPath,
        worktreePath,
        worktreeName: name,
        branchName: branch,
        baseBranch,
        baseCommit,
      };
      const record: WorktreeCheckoutPlan["record"] = {
        projectPath: registeredProjectPath,
        worktreePath,
        branch,
        baseBranch,
        baseCommit,
        state: "active",
        createdAt: new Date().toISOString(),
      };
      if (parent) Object.assign(record, { parentWorktreePath: parent.worktreePath });
      const plan: WorktreeCheckoutPlan = { record };
      if (settings?.worktreeCreateCommand.trim())
        Object.assign(plan, {
          createCommand: renderWorktreeCommand(settings.worktreeCreateCommand, variables),
        });
      if (settings?.worktreeSetupCommands.trim())
        Object.assign(plan, {
          setupCommand: renderWorktreeCommand(settings.worktreeSetupCommands, variables),
        });
      return plan;
    },
    Effect.mapError(
      (cause) =>
        new ManagedWorktreeError({
          operation: backgroundSetup
            ? "ManagedWorktrees.createWithBackgroundSetup"
            : "ManagedWorktrees.create",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    ),
  );
  return yield* worktrees.createCheckout(projectPath, prepare, backgroundSetup);
});
