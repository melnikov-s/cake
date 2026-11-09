/* global console, process */
// Isolated built snapshots only; never attach to the user's desktop.
// Usage: pnpm validation:run -- node scripts/performance/desktop-startup.mjs OUTPUT [--profile-imports]
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "../queued-electron.mjs";

const root = resolve(import.meta.dirname, "../..");
/**
 * @param {string} output
 * @param {{ profileImports?: boolean, auditImports?: boolean, recoveryDelay?: number, waitForRecovery?: boolean,
 * seed?: (paths: { cakeHome: string, userData: string, temporary: string }) => Promise<void> }} options
 */
export async function measureDesktopStartup(
  output,
  {
    profileImports = false,
    auditImports = false,
    recoveryDelay = 0,
    waitForRecovery = true,
    seed,
  } = {},
) {
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "cake-startup-measure-"));
  let application;
  try {
    await cp(join(root, "out"), join(temporary, "out"), { recursive: true });
    await cp(join(root, "package.json"), join(temporary, "package.json"));
    await symlink(join(root, "node_modules"), join(temporary, "node_modules"), "dir");
    if (recoveryDelay) {
      const { readdir } = await import("node:fs/promises");
      const directory = join(temporary, "out/main");
      const marker =
        "const recovery = yield* RuntimeRecoveryStorage;\n      const coordination = yield* SessionCoordination;";
      const settled = 'yield* startupDiagnostics.mark("backend-recovery-ready");';
      // Rollup may name the shared desktop chunk main-* or index-*. Find the
      // actual recovery program in this snapshot instead of assuming its name.
      const candidates = [];
      for (const file of await readdir(directory)) {
        if (!file.endsWith(".js")) continue;
        const path = join(directory, file);
        const source = await readFile(path, "utf8");
        if (source.includes(marker) && source.includes(settled)) candidates.push({ path, source });
      }
      if (candidates.length !== 1) throw new Error("Expected one recovery fixture injection point");
      const { path, source } = candidates[0];
      await writeFile(
        path,
        `globalThis.cakeRecoverySettled = Promise.withResolvers();\n${source.replace(marker, `yield* Effect.sleep(${recoveryDelay});\n${marker}`).replace(settled, `${settled}\nglobalThis.cakeRecoverySettled.resolve();`)}`,
      );
    }
    if (auditImports) {
      const path = join(temporary, "out/main/main.js");
      await writeFile(
        path,
        `import { registerHooks } from "node:module";
globalThis.cakeStartupModules = [];
registerHooks({ load(url, context, next) { globalThis.cakeStartupModules.push(url); return next(url, context); } });
${(await readFile(path, "utf8")).replace(".catch(async (cause)", ".then(() => { globalThis.cakeInitialModules = [...globalThis.cakeStartupModules]; }).catch(async (cause)")}`,
      );
    }
    if (profileImports) {
      const bootstrapPath = join(temporary, "out/main/main.js");
      const bootstrap = await readFile(bootstrapPath, "utf8");
      await writeFile(
        bootstrapPath,
        `import { Session } from 'node:inspector/promises';
import { writeFile } from 'node:fs/promises';
const profiler = new Session();
profiler.connect();
await profiler.post('Profiler.enable');
await profiler.post('Profiler.setSamplingInterval', { interval: 500 });
await profiler.post('Profiler.start');
${bootstrap.replace(
  ".catch(async (cause)",
  `.finally(async () => {
  const { profile } = await profiler.post('Profiler.stop');
  profiler.disconnect();
  await writeFile(${JSON.stringify(join(output, "imports.cpuprofile"))}, JSON.stringify(profile));
}).catch(async (cause)`,
)}
`,
      );
    }
    const cakeHome = join(temporary, "cake-home");
    const userData = join(temporary, "user-data");
    await seed?.({ cakeHome, userData, temporary });
    application = await electron.launch({
      args: [temporary],
      cwd: temporary,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: cakeHome,
        CAKE_ELECTRON_USER_DATA: userData,
        PI_CODING_AGENT_DIR: join(temporary, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const errors = [];
    const stdout = [];
    application.process().stderr.on("data", (chunk) => errors.push(chunk.toString()));
    application.process().stdout.on("data", (chunk) => stdout.push(chunk.toString()));
    const page = await application.firstWindow();
    await page.waitForFunction(
      () => performance.getEntriesByName("cake.startup.first-commit").length > 0,
      undefined,
      { timeout: 30_000 },
    );
    await page.screenshot({ path: join(output, "shell.png") });
    await page
      .getByRole("combobox", { name: "Message Cake Chat", exact: true })
      .waitFor({ timeout: 30_000 });
    if (recoveryDelay && waitForRecovery)
      await application.evaluate(async () => {
        await globalThis.cakeRecoverySettled.promise;
      });
    // The shell capture above precedes reconciliation. Capture the final
    // composer only after the fixture's barrier, not while its observers unblock.
    // An empty profile has no live selected projection: this is not chat readiness.
    if (!recoveryDelay || waitForRecovery)
      await page.screenshot({ path: join(output, "composer.png") });
    if (auditImports)
      await writeFile(
        join(output, "loaded-modules.json"),
        JSON.stringify(
          await application.evaluate(() => ({
            initial: globalThis.cakeInitialModules,
            throughComposer: globalThis.cakeStartupModules,
          })),
          null,
          2,
        ),
      );
    // Browser-context close can bypass Cake's native quit/flush path. Request
    // the real lifecycle in this owned snapshot and wait for process exit before
    // reading the batched logger or removing its isolated files.
    const closed = application.waitForEvent("close", { timeout: 15_000 });
    await application.evaluate(({ app }) => app.quit());
    await closed;
    application = undefined;
    const log = await readFile(join(cakeHome, "logs/desktop.log"), "utf8");
    if (seed) {
      await cp(join(cakeHome, "state/saved-drafts.json"), join(output, "saved-drafts.json"));
      await cp(join(userData, "window-state.json"), join(output, "window-state.json"));
    }
    await writeFile(join(output, "desktop.log"), log);
    await writeFile(join(output, "stderr.log"), errors.join(""));
    await writeFile(join(output, "stdout.log"), stdout.join(""));
    await cp(join(cakeHome, "logs/desktop-shutdown.log"), join(output, "desktop-shutdown.log"));
    console.log(
      log
        .split("\n")
        .filter((line) =>
          /"phase":"(desktop-bootstrap|backend-recovery-ready|window-created|first-commit|selected-chat-projection-commit)"/.test(
            line,
          ),
        )
        .join("\n"),
    );
    return log;
  } finally {
    if (application) await application.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await measureDesktopStartup(resolve(process.argv[2]), {
    profileImports: process.argv.includes("--profile-imports"),
    auditImports: process.argv.includes("--audit-imports"),
    recoveryDelay: Number(
      process.argv.find((arg) => arg.startsWith("--slow-recovery-ms="))?.split("=")[1] ?? 0,
    ),
  });
}
