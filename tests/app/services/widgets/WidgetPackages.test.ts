import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer, ManagedRuntime, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, describe, expect, it } from "vitest";
import { WidgetPackages } from "../../../../src/services/widgets/WidgetPackages";
import { makeWidgetPackagesLive } from "../../../../src/services/widgets/WidgetPackagesLive";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const fixture = async (exitCode = 0) => {
  const root = await mkdtemp(join(tmpdir(), "cake-widget-service-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "widget-packages");
  const calls: Array<{ command: string; args: readonly string[]; cwd: string | undefined }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") throw new Error("Unexpected pipeline");
      calls.push({ command: command.command, args: command.args, cwd: command.options.cwd });
      if (exitCode === 0)
        yield* Effect.promise(async () => {
          await writeFile(
            join(directory, "package.json"),
            JSON.stringify({
              private: true,
              dependencies: command.args[0] === "install" ? { "vis-network": "9.1.9" } : {},
            }),
          );
          const installed = join(directory, "node_modules", "vis-network");
          if (command.args[0] === "install") {
            await mkdir(installed, { recursive: true });
            await writeFile(join(installed, "package.json"), JSON.stringify({ version: "9.1.9" }));
          } else await rm(installed, { recursive: true, force: true });
        });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.make(Buffer.from(exitCode ? "registry unavailable" : "installed")),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  const runtime = ManagedRuntime.make(
    makeWidgetPackagesLive({ directory }).pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeFileSystem.layer,
          NodePath.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    ),
  );
  cleanup.push(() => runtime.dispose());
  return { directory, calls, runtime, service: await runtime.runPromise(WidgetPackages) };
};

describe("shared widget package environment", () => {
  it("lists, installs and removes only in its backend directory, with scripts/peer installs disabled", async () => {
    const { service, directory, calls } = await fixture();
    expect(await Effect.runPromise(service.list())).toEqual({ directory, packages: [] });
    expect(await Effect.runPromise(service.install("vis-network@9.1.9"))).toEqual({
      directory,
      packages: [{ name: "vis-network", version: "9.1.9" }],
    });
    expect(await Effect.runPromise(service.remove("vis-network"))).toEqual({
      directory,
      packages: [],
    });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.cwd).toBe(directory);
      expect(call.args).toContain("--ignore-scripts");
      expect(call.args).toContain("--legacy-peer-deps");
      expect(call.args).toContain(join(directory, ".npm-cache"));
    }
    expect(JSON.parse(await readFile(join(directory, "package.json"), "utf8")).private).toBe(true);
  });

  it("reports a failed package manager instead of falsely claiming successful installation", async () => {
    const { service } = await fixture(1);
    await expect(Effect.runPromise(service.install("vis-network@9.1.9"))).rejects.toThrow(
      "exited 1: registry unavailable",
    );
    expect((await Effect.runPromise(service.list())).packages).toEqual([]);
  });

  it("validates registry names and reserves the compiler React singleton before invoking npm", async () => {
    const { service, calls } = await fixture();
    for (const specifier of [
      "react",
      "react-dom@19",
      "../package",
      "https://example.com/a.tgz",
      "npm:alias",
      "--prefix=/app",
    ])
      await expect(Effect.runPromise(service.install(specifier))).rejects.toThrow();
    await expect(Effect.runPromise(service.remove("react-dom"))).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
