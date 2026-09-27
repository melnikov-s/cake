import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { Effect, Stream } from "effect";
import { beforeAll, expect, it } from "vitest";
import { connectClient } from "./fixtures/network-client";

const execFileAsync = promisify(execFile);

beforeAll(async () => {
  await execFileAsync(process.execPath, ["scripts/build-server.mjs"]);
}, 30_000);

it.each([
  ["CAKE_SERVER_ENABLED", "not-a-boolean"],
  ["CAKE_SERVER_PORT", "-1"],
  ["CAKE_SERVER_ALLOWED_ORIGINS", "*"],
])(
  "invalid_network_configuration_fails_before_backend_acquisition (%s)",
  async (key, value) => {
    const root = await mkdtemp(join(process.cwd(), ".network-node-test-"));
    try {
      const result = await execFileAsync(process.execPath, ["out/server/main.mjs"], {
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CAKE_HOME: root,
          CAKE_SERVER_ENABLED: "true",
          [key]: value,
        },
        timeout: 30_000,
      }).then(
        () => {
          throw new Error("Invalid network configuration unexpectedly booted");
        },
        (error: unknown) => {
          if (!(error instanceof Error) || !("stdout" in error) || !("code" in error)) throw error;
          return error;
        },
      );
      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("Cake headless backend ready");
      expect(result.stdout).not.toContain("Cake headless RPC listening");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  45_000,
);

it("opt_in_node_host_serves_two_real_rpc_clients_without_electron_or_provider_traffic", async () => {
  const root = await mkdtemp(join(process.cwd(), ".network-node-test-"));
  const hook = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === "electron" || specifier.startsWith("electron/")) throw new Error("Forbidden Electron import");
    return nextResolve(specifier, context);
  }`;
  const bootstrap = `
    import { register } from "node:module";
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)}, import.meta.url);
    let fetches = 0;
    globalThis.fetch = () => { fetches++; throw new Error("Unexpected provider/network fetch"); };
    process.on("exit", () => {
      if (fetches !== 0) throw new Error("Backend attempted " + fetches + " unexpected fetches");
    });
    await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "out/server/main.mjs")).href)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", bootstrap], {
    env: {
      PATH: process.env.PATH,
      HOME: root,
      CAKE_HOME: root,
      CAKE_SERVER_ENABLED: "true",
      CAKE_SERVER_PORT: "0",
      CAKE_SERVER_ALLOW_MISSING_ORIGIN: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        const address = /Cake headless RPC listening at (ws:\/\/127\.0\.0\.1:\d+\/rpc)/.exec(
          stdout,
        )?.[1];
        if (address) resolve(address);
      });
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error(`Server exited before ready: ${stdout}\n${stderr}`)),
      );
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* connectClient(url);
        const b = yield* connectClient(url);
        yield* a.client["application.setSessionPluginSharedState"]({
          sessionId: "test",
          key: "shared",
          value: "one production backend",
        });
        expect(JSON.stringify(yield* b.client["application.getState"]())).toContain(
          "one production backend",
        );
        expect(yield* b.client["application.getHomeDirectory"]()).toBe(root);
        const catalog = yield* b.client["projects.observeCatalog"]().pipe(Stream.runHead);
        expect(catalog._tag).toBe("Some");
      }).pipe(Effect.scoped),
    );
    child.kill("SIGTERM");
    expect(await exit).toEqual({ code: 130, signal: null });
    expect(stderr).toBe("");
    expect(stdout).toContain("Cake headless backend stopped");
    expect(stdout).toContain("full backend authority");
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exit;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
