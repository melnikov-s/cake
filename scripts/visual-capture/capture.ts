import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { _electron as electron, chromium, type ElectronApplication } from "@playwright/test";
import {
  findBrowserVisualScenario,
  prepareBrowserVisual,
  seedBrowserVisual,
} from "./browser-scenarios.ts";
import type { VisualCaptureOptions } from "./arguments.ts";
import { parsePngDimensions, type VisualCaptureResult } from "./result.ts";
import { findVisualCaptureScenario } from "./scenarios.ts";

export interface CaptureVisualDependencies {
  readonly repositoryRoot?: string;
  readonly onTemporaryRoot?: (path: string) => void;
}

export async function captureVisual(
  options: VisualCaptureOptions,
  dependencies: CaptureVisualDependencies = {},
): Promise<VisualCaptureResult> {
  if (!options.scenario) throw new Error("A scenario is required");
  const browserScenario = findBrowserVisualScenario(options.scenario);
  const scenario = findVisualCaptureScenario(options.scenario);
  if (!scenario && !browserScenario)
    throw new Error(
      `Unknown scenario "${options.scenario}". Use --list to see available scenarios.`,
    );
  if (browserScenario && options.state !== "default")
    throw new Error(`Scenario "${browserScenario.name}" supports only state "default".`);
  if (scenario && !scenario.states.includes(options.state))
    throw new Error(
      `Scenario "${scenario.name}" does not support state "${options.state}". ` +
        `Choose: ${scenario.states.join(", ")}.`,
    );

  const repositoryRoot = resolve(dependencies.repositoryRoot ?? join(import.meta.dirname, "../.."));
  if (options.build) {
    if (browserScenario) await buildBrowserApplication(repositoryRoot);
    else await buildCompiledApplication(repositoryRoot);
  }

  const outputPath = resolve(
    options.output ??
      join(
        options.outputDirectory,
        `${options.scenario}-${options.state}-${options.theme}-${options.capture}-${options.width}x${options.height}.png`,
      ),
  );
  if (!outputPath.toLowerCase().endsWith(".png"))
    throw new Error(`Output must be a .png file: ${outputPath}`);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-visual-capture-"));
  dependencies.onTemporaryRoot?.(temporaryRoot);
  const paths = {
    cakeHome: join(temporaryRoot, "cake-home"),
    project: join(temporaryRoot, "project"),
    userData: join(temporaryRoot, "electron-user-data"),
  };
  let application: ElectronApplication | undefined;

  try {
    if (browserScenario) {
      await seedBrowserVisual(paths);
      const png = await captureBrowserPage(repositoryRoot, paths, options, browserScenario.name);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, png);
      return {
        schemaVersion: 1,
        scenario: browserScenario.name,
        state: options.state,
        dimensions: parsePngDimensions(png),
        outputPath,
        mimeType: "image/png",
        checksum: `sha256:${createHash("sha256").update(png).digest("hex")}`,
      };
    }
    if (!scenario) throw new Error("Missing Electron scenario");
    await scenario.seed(paths, options.theme);
    application = await electron.launch({
      args: ["--force-device-scale-factor=1", repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
      },
    });
    const page = await application.firstWindow();
    // Sandboxed documents follow media preferences, not the host's theme class.
    await page.emulateMedia({ colorScheme: options.theme });
    await application.evaluate(
      ({ BrowserWindow }, dimensions) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (!window) throw new Error("Cake did not create a browser window");
        window.setContentSize(dimensions.width, dimensions.height);
      },
      { width: options.width, height: options.height },
    );
    await page.waitForFunction(
      (dimensions) => innerWidth === dimensions.width && innerHeight === dimensions.height,
      { width: options.width, height: options.height },
    );
    await scenario.prepare(page, options.state, application);

    const target = options.capture === "window" ? page : scenario.region(page);
    await mkdir(dirname(outputPath), { recursive: true });
    const png = await target.screenshot({ animations: "disabled", type: "png" });
    await writeFile(outputPath, png);
    const dimensions = parsePngDimensions(png);
    return {
      schemaVersion: 1,
      scenario: scenario.name,
      state: options.state,
      dimensions,
      outputPath,
      mimeType: "image/png",
      checksum: `sha256:${createHash("sha256").update(png).digest("hex")}`,
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Capture ${options.scenario}/${options.state} failed before writing ${basename(outputPath)}: ${detail}`,
      { cause },
    );
  } finally {
    if (application) await application.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function captureBrowserPage(
  repositoryRoot: string,
  paths: { cakeHome: string; project: string },
  options: VisualCaptureOptions,
  scenario: string,
) {
  const server = spawn(process.execPath, [join(repositoryRoot, "out/server/main.mjs")], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: paths.cakeHome,
      CAKE_HOME: paths.cakeHome,
      CAKE_SERVER_ENABLED: "true",
      CAKE_SERVER_BROWSER_ENABLED: "true",
      CAKE_SERVER_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise<void>((done) => server.once("exit", () => done()));
  server.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const timeout = setTimeout(() => server.kill("SIGKILL"), 90_000);
  try {
    const origin = await new Promise<string>((done, fail) => {
      server.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = /Cake browser chat at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
        if (match?.[1]) done(match[1]);
      });
      server.once("exit", () =>
        fail(new Error(`Browser backend exited before readiness: ${output}`)),
      );
      server.once("error", fail);
    });
    const browser = await chromium.launch({ channel: "chromium-headless-shell" });
    try {
      const context = await browser.newContext({
        viewport: { width: options.width, height: options.height },
        deviceScaleFactor: 1,
        colorScheme: options.theme,
      });
      const page = await context.newPage();
      await page.goto(origin);
      await prepareBrowserVisual(page, scenario);
      return await page.screenshot({ animations: "disabled", type: "png" });
    } finally {
      await browser.close();
    }
  } finally {
    clearTimeout(timeout);
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
    await exited;
  }
}

async function buildBrowserApplication(repositoryRoot: string) {
  await runBuild(repositoryRoot, [process.execPath, "scripts/build-server.mjs"]);
  await runBuild(repositoryRoot, [
    process.execPath,
    "node_modules/vite/bin/vite.js",
    "build",
    "--config",
    "vite.browser.config.ts",
  ]);
}

function runBuild(repositoryRoot: string, command: string[]) {
  return new Promise<void>((done, fail) => {
    const child = spawn(command[0]!, command.slice(1), { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", fail);
    child.once("exit", (code) =>
      code === 0 ? done() : fail(new Error(`Browser build failed with exit code ${code}`)),
    );
  });
}

function buildCompiledApplication(repositoryRoot: string) {
  return new Promise<void>((resolvePromise, reject) => {
    const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const child = spawn(executable, ["exec", "electron-vite", "build", "--logLevel", "warn"], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    child.once("error", (cause) =>
      reject(new Error(`Could not start the Cake build: ${cause.message}`, { cause })),
    );
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `Cake build failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}`,
          ),
        );
    });
  });
}
