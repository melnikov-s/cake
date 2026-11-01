import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect, Layer } from "effect";
import { Git, GitError, type GitRunner } from "./Git";
import { shutdownDiagnostics, shutdownResource } from "../diagnostics/shutdown-diagnostics";

const execFileAsync = promisify(execFile);
const maxBuffer = 4_000_000;

export const makeGitLive = (runner?: GitRunner): Layer.Layer<Git> => {
  const runUnsafe: GitRunner =
    runner ??
    (async (workingDirectory, arguments_) => {
      const { stdout } = await execFileAsync("git", [...arguments_], {
        cwd: workingDirectory,
        maxBuffer,
      });
      return stdout;
    });

  const service = Git.of({
    run: Effect.fn("Git.run")((workingDirectory, arguments_) =>
      Effect.tryPromise({
        try: () =>
          shutdownDiagnostics.promise("git.run", shutdownResource(workingDirectory), () =>
            runUnsafe(workingDirectory, arguments_),
          ),
        catch: (cause) =>
          new GitError({
            operation: `git ${arguments_.join(" ")}`,
            workingDirectory,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
    ),
  });

  return Layer.succeed(Git, service);
};
