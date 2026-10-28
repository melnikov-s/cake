import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { BootstrapLive } from "../../src/main/BootstrapLive";
import {
  WorktreeCommands,
  type WorktreeCommandRequest,
} from "../../src/services/worktrees/WorktreeCommands";
import { makeWorktreeCommandsLive } from "../../src/services/worktrees/WorktreeCommandsLive";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<WorktreeCommands, never>> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "cake-worktree-commands-"));
  directories.push(directory);
  const logs = join(directory, "logs");
  const runtime = ManagedRuntime.make(
    makeWorktreeCommandsLive(logs).pipe(Layer.provide(BootstrapLive)),
  );
  runtimes.push(runtime);
  const run = (request: Omit<WorktreeCommandRequest, "workingDirectory" | "logName">) =>
    runtime.runPromise(
      Effect.flatMap(WorktreeCommands, (commands) =>
        commands.run({ workingDirectory: directory, logName: "fix-abc123", ...request }),
      ).pipe(Effect.result),
    );
  return { directory, logPath: join(logs, "fix-abc123.log"), run };
}

describe("WorktreeCommands", { timeout: 20_000 }, () => {
  it.each([
    ["an explicit exit status", "echo before; exit 3", 3],
    ["a failing command under set -e", "false\necho never", 1],
  ])("fails %s with its output and log", async (_name, script, code) => {
    const { run, logPath } = await harness();
    const result = await run({ label: "setup", script });
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "WorktreeCommandError", reason: "exit", logPath },
    });
    if (result._tag !== "Failure") return;
    expect(result.failure.message).toContain(`failed with exit code ${code}`);
    expect(result.failure.message).toContain(`Full log: ${logPath}`);
    expect(await readFile(logPath, "utf8")).not.toContain("never");
  });

  it("drains large output into the log instead of stalling on a full pipe", async () => {
    const { run, logPath } = await harness();
    const result = await run({
      label: "create",
      // ~400 KB on stderr and stdout: more than any pipe buffer.
      script: `i=0; while [ $i -lt 4000 ]; do printf '%0100d\\n' $i >&2; printf '%0100d\\n' $i; i=$((i+1)); done`,
    });
    expect(result._tag).toBe("Success");
    expect((await readFile(logPath, "utf8")).length).toBeGreaterThan(800_000);
  });

  it("closes stdin so a prompting tool cannot wait forever", async () => {
    const { run, logPath } = await harness();
    const result = await run({
      label: "create",
      script: `if read answer; then echo "read:$answer"; else echo "stdin closed"; fi`,
    });
    expect(result._tag).toBe("Success");
    expect(await readFile(logPath, "utf8")).toContain("stdin closed");
  });

  it("stops a command and its children when the timeout expires", async () => {
    const { run, directory } = await harness();
    const marker = join(directory, "child-survived");
    const started = Date.now();
    const result = await run({
      label: "remove",
      script: `(sleep 2; touch '${marker}') & sleep 30`,
      timeout: "500 millis",
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "timeout" } });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(existsSync(marker)).toBe(false);
  });

  it("resolves tools through Cake's own PATH rather than a login shell's", async () => {
    const { run, logPath } = await harness();
    const expected = (await execFileAsync("/bin/sh", ["-c", "command -v git"])).stdout.trim();
    expect((await run({ label: "create", script: "command -v git" }))._tag).toBe("Success");
    expect(await readFile(logPath, "utf8")).toContain(`${expected}\n`);
  });
});
