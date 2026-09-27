import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const hook = `export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron" || specifier.startsWith("electron/"))
    throw new Error("Forbidden Electron runtime dependency: " + specifier);
  return nextResolve(specifier, context);
}`;
const bootstrap = (file: string) => `
  import { register } from "node:module";
  register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)}, import.meta.url);
  let networkRequests = 0;
  globalThis.fetch = () => { networkRequests++; throw new Error("Unexpected network request"); };
  process.on("exit", () => {
    if (networkRequests !== 0) throw new Error("Backend attempted " + networkRequests + " network requests");
  });
  await import(${JSON.stringify(pathToFileURL(file).href)});
`;
const environment = (root: string) => ({
  PATH: process.env.PATH,
  HOME: root,
  CAKE_HOME: root,
});

beforeAll(async () => {
  // All entrypoint checks exercise the actual production build command.
  await execFileAsync(process.execPath, ["scripts/build-server.mjs"]);
}, 30_000);

it.each([undefined, "relative/cake-data", ""])(
  "headless_boot_rejects_invalid_CAKE_HOME (%s) before creating data",
  async (home) => {
    const root = await mkdtemp(join(process.cwd(), ".headless-node-test-"));
    try {
      const result = await execFileAsync(
        process.execPath,
        ["--input-type=module", "--eval", bootstrap(join(process.cwd(), "out/server/main.mjs"))],
        { env: { ...environment(root), CAKE_HOME: home }, cwd: root, timeout: 30_000 },
      ).then(
        () => {
          throw new Error("Invalid CAKE_HOME unexpectedly booted");
        },
        (error: unknown) => {
          if (!(error instanceof Error) || !("stdout" in error) || !("code" in error)) throw error;
          return error;
        },
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("CAKE_HOME");
      expect(result.stdout).not.toContain("Cake headless backend ready");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  45_000,
);

it("headless_boot_has_no_electron_runtime_dependency", async () => {
  const root = await mkdtemp(join(process.cwd(), ".headless-node-test-"));
  try {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", bootstrap(join(process.cwd(), "out/server/main.mjs"))],
      { env: environment(root), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let ready = false;
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
        if (!ready && stdout.includes("Cake headless backend ready")) {
          ready = true;
          child.kill("SIGTERM");
        }
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      const exit = await new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.on("error", reject);
          child.on("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      expect({ ready, stderr, exit }).toEqual({
        ready: true,
        stderr: "",
        exit: { code: 130, signal: null },
      });
      expect(stdout).toContain("Cake headless backend stopped");
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);

it("production_backend_shares_authorities_initializes_projects_and_releases_real_sessions", async () => {
  const root = await mkdtemp(join(process.cwd(), ".headless-node-test-"));
  try {
    const output = join(root, "backend-check.mjs");
    // Reuse the production bundler's raw-prompt handling, not a test-only loader.
    await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      `
      import { build } from "esbuild";
      import { serverBuildOptions } from "./scripts/build-server.mjs";
      await build({ ...serverBuildOptions, entryPoints: ["tests/integration/fixtures/headless-backend.ts"], outfile: ${JSON.stringify(output)} });
    `,
    ]);
    const result = await execFileAsync(
      process.execPath,
      ["--input-type=module", "--eval", bootstrap(output)],
      {
        env: environment(root),
        timeout: 30_000,
      },
    );
    expect(result.stdout).toContain("headless-backend-check-ok");
    expect(result.stderr).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
