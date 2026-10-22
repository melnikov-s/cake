import { describe, expect, it } from "vitest";
import { _electron as electron } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { Deferred, Effect } from "effect";
import { WorkflowSandbox } from "../../src/services/pi/WorkflowSandbox";
import { WorkflowSandboxLive } from "../../src/services/pi/live/WorkflowSandboxLive";
import type { WorkflowScriptHost } from "../../src/services/pi/WorkflowSandbox";
import type { WorkflowProgram } from "../../src/contracts/workflows/workflow-data";

const program = (body: string, args?: WorkflowProgram["args"]): WorkflowProgram => ({
  meta: { name: "test-run", description: "Sandbox integration" },
  source: `export const meta = { name: "test-run", description: "Sandbox integration" };\n${body}`,
  sourcePath: "/test/workflow.js",
  ...(args === undefined ? {} : { args }),
});
const host: WorkflowScriptHost = {
  agent: ({ prompt }) => Effect.succeed(prompt),
  phase: () => Effect.void,
  log: () => Effect.void,
};
const execute = (body: string, args?: WorkflowProgram["args"], bridge = host) =>
  Effect.scoped(
    Effect.gen(function* () {
      return yield* (yield* WorkflowSandbox).execute(program(body, args), bridge);
    }),
  ).pipe(Effect.provide(WorkflowSandboxLive));

describe("Standalone workflow sandbox", () => {
  it("executes top-level await, parameterized args and injected agent calls in QuickJS", async () => {
    expect(
      await Effect.runPromise(execute("return await agent(args.task);", { task: "hello" })),
    ).toBe("hello");
  });
  it("supports bounded pipeline and parallel helpers without exposing filesystem or shell APIs", async () => {
    expect(
      await Effect.runPromise(
        execute(`const results = await pipeline(["a", "b"], item => agent(item));
      const more = await parallel([() => agent("c"), () => agent("d")]);
      return { results, more, capabilities: [typeof process, typeof require, typeof fetch, typeof setTimeout] };`),
      ),
    ).toEqual({
      results: ["a", "b"],
      more: ["c", "d"],
      capabilities: ["undefined", "undefined", "undefined", "undefined"],
    });
  });
  it("rejects nondeterministic Date and Math.random usage while permitting timestamps in args", async () => {
    for (const expression of ["Date.now()", "Math.random()", "new Date()", "Date()"])
      await expect(Effect.runPromise(execute(`return ${expression};`))).rejects.toThrow("disabled");
    expect(
      await Effect.runPromise(
        execute("return new Date(args.timestamp).toISOString();", {
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ).toBe("2026-01-01T00:00:00.000Z");
    // Cake fixes the backing VM too: aliases of Pi's immutable globals cannot
    // introduce nondeterminism when they bypass the lexical workflow helpers.
    const aliased = () =>
      Effect.runPromise(
        execute("return { now: globalThis.Date.now(), random: globalThis.Math.random() };"),
      );
    const first = await aliased();
    expect(first).toMatchObject({ now: 0 });
    expect(await aliased()).toEqual(first);
  });
  it("rejects a 4097-item helper input without silently truncating it", async () => {
    await expect(
      Effect.runPromise(
        execute("return await pipeline(Array(4097).fill(1), item => agent(String(item)));"),
      ),
    ).rejects.toThrow("4096");
  });
  it("interrupts a spinning script without blocking the backend event loop", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(
        Effect.runPromise(execute("while (true) {}"), { signal: controller.signal }),
      ).rejects.toThrow();
    } finally {
      clearTimeout(timer);
    }
  });
  it("cancels unawaited host calls when the script returns", async () => {
    let cancelled = false;
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const bridge: WorkflowScriptHost = {
          ...host,
          agent: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  cancelled = true;
                }),
              ),
            ),
          phase: () => Deferred.await(started),
        };
        expect(
          yield* execute(
            `agent("not-awaited"); await phase("Wait for admission"); return "done";`,
            undefined,
            bridge,
          ),
        ).toBe("done");
      }),
    );
    expect(cancelled).toBe(true);
  });
  it("resolves worker and WebAssembly assets from the compiled Electron backend", async () => {
    const root = await mkdtemp(join(process.cwd(), ".workflow-electron-test-"));
    const app = await electron.launch({
      args: [process.cwd()],
      cwd: process.cwd(),
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: join(root, "user-data"),
        CAKE_HOME: join(root, "home"),
        PI_CODING_AGENT_DIR: join(root, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const result = await app.evaluate(
        async (_electron, input) => {
          // The compiled main's test-only hook executes the production backend Service.
          const hooks = globalThis as typeof globalThis & {
            cakeSmokeWorkflowSandbox: (value: WorkflowProgram) => Promise<unknown>;
          };
          return await hooks.cakeSmokeWorkflowSandbox(input);
        },
        program("return { answer: await agent(args.message), process: typeof process };", {
          message: "compiled-electron-ok",
        }),
      );
      expect(result).toEqual({ answer: "compiled-electron-ok", process: "undefined" });
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused(),
          ),
        ),
      ).toBe(true);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
  it("executes the same sandbox implementation in the compiled standalone Node backend", async () => {
    const root = await mkdtemp(join(process.cwd(), ".workflow-node-test-"));
    try {
      const output = join(root, "backend-check.mjs");
      await execFileAsync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { build } from "esbuild"; import { serverBuildOptions } from "./scripts/build-server.mjs"; await build({ ...serverBuildOptions, entryPoints: ["tests/integration/fixtures/workflow-sandbox-backend.ts"], outfile: ${JSON.stringify(output)} });`,
        ],
        { timeout: 30000 },
      );
      const hook = `export async function resolve(specifier, context, nextResolve) { if (specifier === "electron" || specifier.startsWith("electron/")) throw new Error("Forbidden Electron runtime dependency"); return nextResolve(specifier, context); }`;
      const bootstrap = `import { register } from "node:module"; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)}, import.meta.url); globalThis.fetch = () => { throw new Error("Unexpected paid/network call"); }; await import(${JSON.stringify(output)});`;
      // Worker threads inherit execArgv: a file entrypoint, like production,
      // must not carry the eval-only --input-type flag into the sandbox thread.
      const entrypoint = join(root, "bootstrap.mjs");
      await writeFile(entrypoint, bootstrap);
      const result = await execFileAsync(
        process.execPath,
        ["--disable-warning=ExperimentalWarning", entrypoint],
        {
          cwd: root,
          timeout: 30000,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            CAKE_HOME: root,
            PI_CODING_AGENT_DIR: join(root, "pi"),
            PI_CODING_AGENT_SESSION_DIR: "",
          },
        },
      );
      expect(result.stdout).toContain("compiled-workflow-backend-ok");
      expect(result.stderr).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45000);
});
